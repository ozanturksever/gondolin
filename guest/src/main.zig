const std = @import("std");
const cbor = @import("sandboxd").cbor;

const log = std.log.scoped(.sandboxd);

const ProtocolError = error{
    InvalidType,
    MissingField,
    UnexpectedType,
    InvalidValue,
};

const ExecRequest = struct {
    id: u32,
    cmd: []const u8,
    argv: []const []const u8,
    env: []const []const u8,
    cwd: ?[]const u8,
    stdin: bool,
};

const StdinData = struct {
    data: []const u8,
    eof: bool,
};

const Termination = struct {
    exit_code: i32,
    signal: ?i32,
};

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    var virtio = try std.fs.openFileAbsolute("/dev/vport0p0", .{ .mode = .read_write });
    defer virtio.close();
    const virtio_fd: std.posix.fd_t = virtio.handle;

    while (true) {
        const frame = readFrame(allocator, virtio_fd) catch |err| {
            if (err == error.EndOfStream) break;
            log.err("failed to read frame: {s}", .{@errorName(err)});
            continue;
        };
        defer allocator.free(frame);

        var dec = cbor.Decoder.init(allocator, frame);
        const root = dec.decodeValue() catch |err| {
            log.err("failed to decode cbor: {s}", .{@errorName(err)});
            continue;
        };
        defer cbor.freeValue(allocator, root);

        const req = parseExecRequest(allocator, root) catch |err| {
            log.err("invalid exec_request: {s}", .{@errorName(err)});
            _ = sendError(allocator, virtio_fd, 0, "invalid_request", "invalid exec_request") catch {};
            continue;
        };
        defer {
            allocator.free(req.argv);
            allocator.free(req.env);
        }

        handleExec(allocator, virtio_fd, req) catch |err| {
            log.err("exec handling failed: {s}", .{@errorName(err)});
            _ = sendError(allocator, virtio_fd, req.id, "exec_failed", "failed to execute") catch {};
        };
    }
}

fn parseExecRequest(allocator: std.mem.Allocator, root: cbor.Value) !ExecRequest {
    const map = try expectMap(root);
    const msg_type = try expectText(cbor.getMapValue(map, "t") orelse return ProtocolError.MissingField);
    if (!std.mem.eql(u8, msg_type, "exec_request")) {
        return ProtocolError.UnexpectedType;
    }

    const id_val = cbor.getMapValue(map, "id") orelse return ProtocolError.MissingField;
    const id = try expectU32(id_val);

    const payload_val = cbor.getMapValue(map, "p") orelse return ProtocolError.MissingField;
    const payload = try expectMap(payload_val);

    const cmd = try expectText(cbor.getMapValue(payload, "cmd") orelse return ProtocolError.MissingField);

    const argv = try parseTextArray(allocator, cbor.getMapValue(payload, "argv"));
    errdefer allocator.free(argv);

    const env = try parseTextArray(allocator, cbor.getMapValue(payload, "env"));
    errdefer allocator.free(env);

    var cwd: ?[]const u8 = null;
    if (cbor.getMapValue(payload, "cwd")) |cwd_val| {
        cwd = try expectText(cwd_val);
    }

    var stdin_flag = false;
    if (cbor.getMapValue(payload, "stdin")) |stdin_val| {
        stdin_flag = try expectBool(stdin_val);
    }

    return ExecRequest{
        .id = id,
        .cmd = cmd,
        .argv = argv,
        .env = env,
        .cwd = cwd,
        .stdin = stdin_flag,
    };
}

fn parseStdinData(root: cbor.Value, expected_id: u32) !StdinData {
    const map = try expectMap(root);
    const msg_type = try expectText(cbor.getMapValue(map, "t") orelse return ProtocolError.MissingField);
    if (!std.mem.eql(u8, msg_type, "stdin_data")) {
        return ProtocolError.UnexpectedType;
    }

    const id_val = cbor.getMapValue(map, "id") orelse return ProtocolError.MissingField;
    const id = try expectU32(id_val);
    if (id != expected_id) return ProtocolError.InvalidValue;

    const payload_val = cbor.getMapValue(map, "p") orelse return ProtocolError.MissingField;
    const payload = try expectMap(payload_val);

    const data_val = cbor.getMapValue(payload, "data") orelse return ProtocolError.MissingField;
    const data = try expectBytes(data_val);

    var eof = false;
    if (cbor.getMapValue(payload, "eof")) |eof_val| {
        eof = try expectBool(eof_val);
    }

    return .{ .data = data, .eof = eof };
}

fn handleExec(allocator: std.mem.Allocator, virtio_fd: std.posix.fd_t, req: ExecRequest) !void {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const arena_alloc = arena.allocator();

    const argv = try buildArgv(arena_alloc, req.cmd, req.argv);
    const envp = try buildEnvp(arena_alloc, allocator, req.env);

    const stdout_pipe = try std.posix.pipe2(.{ .CLOEXEC = true });
    errdefer {
        std.posix.close(stdout_pipe[0]);
        std.posix.close(stdout_pipe[1]);
    }

    const stderr_pipe = try std.posix.pipe2(.{ .CLOEXEC = true });
    errdefer {
        std.posix.close(stderr_pipe[0]);
        std.posix.close(stderr_pipe[1]);
    }

    var stdin_pipe: ?[2]std.posix.fd_t = null;
    if (req.stdin) {
        stdin_pipe = try std.posix.pipe2(.{ .CLOEXEC = true });
        errdefer {
            std.posix.close(stdin_pipe.?[0]);
            std.posix.close(stdin_pipe.?[1]);
        }
    }

    const pid = try std.posix.fork();
    if (pid == 0) {
        if (req.stdin) {
            try std.posix.dup2(stdin_pipe.?[0], std.posix.STDIN_FILENO);
        } else {
            const devnull = std.posix.openZ("/dev/null", .{ .ACCMODE = .RDONLY }, 0) catch std.posix.exit(127);
            try std.posix.dup2(devnull, std.posix.STDIN_FILENO);
            std.posix.close(devnull);
        }

        try std.posix.dup2(stdout_pipe[1], std.posix.STDOUT_FILENO);
        try std.posix.dup2(stderr_pipe[1], std.posix.STDERR_FILENO);

        std.posix.close(stdout_pipe[0]);
        std.posix.close(stdout_pipe[1]);
        std.posix.close(stderr_pipe[0]);
        std.posix.close(stderr_pipe[1]);

        if (req.stdin) {
            std.posix.close(stdin_pipe.?[0]);
            std.posix.close(stdin_pipe.?[1]);
        }

        if (req.cwd) |cwd| {
            _ = std.posix.chdir(cwd) catch std.posix.exit(127);
        }

        std.posix.execvpeZ(argv[0].?, argv, envp) catch {
            const msg = "exec failed\n";
            _ = std.posix.write(std.posix.STDERR_FILENO, msg) catch {};
            std.posix.exit(127);
        };
    }

    std.posix.close(stdout_pipe[1]);
    std.posix.close(stderr_pipe[1]);

    var stdin_fd: ?std.posix.fd_t = null;
    if (req.stdin) {
        std.posix.close(stdin_pipe.?[0]);
        stdin_fd = stdin_pipe.?[1];
    }

    var stdout_open = true;
    var stderr_open = true;
    var stdin_open = req.stdin;

    var status: ?u32 = null;
    var buffer: [8192]u8 = undefined;

    while (true) {
        if (status != null and !stdout_open and !stderr_open) break;

        var pollfds: [3]std.posix.pollfd = undefined;
        var nfds: usize = 0;

        if (stdout_open) {
            pollfds[nfds] = .{ .fd = stdout_pipe[0], .events = std.posix.POLL.IN, .revents = 0 };
            nfds += 1;
        }
        if (stderr_open) {
            pollfds[nfds] = .{ .fd = stderr_pipe[0], .events = std.posix.POLL.IN, .revents = 0 };
            nfds += 1;
        }
        if (stdin_open) {
            pollfds[nfds] = .{ .fd = virtio_fd, .events = std.posix.POLL.IN, .revents = 0 };
            nfds += 1;
        }

        _ = try std.posix.poll(pollfds[0..nfds], 100);

        var index: usize = 0;
        if (stdout_open) {
            const revents = pollfds[index].revents;
            index += 1;
            if ((revents & (std.posix.POLL.IN | std.posix.POLL.HUP)) != 0) {
                const n = try std.posix.read(stdout_pipe[0], buffer[0..]);
                if (n == 0) {
                    stdout_open = false;
                    std.posix.close(stdout_pipe[0]);
                } else {
                    try sendExecOutput(allocator, virtio_fd, req.id, "stdout", buffer[0..n]);
                }
            }
        }

        if (stderr_open) {
            const revents = pollfds[index].revents;
            index += 1;
            if ((revents & (std.posix.POLL.IN | std.posix.POLL.HUP)) != 0) {
                const n = try std.posix.read(stderr_pipe[0], buffer[0..]);
                if (n == 0) {
                    stderr_open = false;
                    std.posix.close(stderr_pipe[0]);
                } else {
                    try sendExecOutput(allocator, virtio_fd, req.id, "stderr", buffer[0..n]);
                }
            }
        }

        if (stdin_open) {
            const revents = pollfds[index].revents;
            index += 1;
            if ((revents & (std.posix.POLL.IN | std.posix.POLL.HUP)) != 0) {
                stdin_open = handleStdin(allocator, virtio_fd, stdin_fd.?, req.id) catch |err| blk: {
                    log.err("stdin handling failed: {s}", .{@errorName(err)});
                    if (stdin_fd) |fd| std.posix.close(fd);
                    break :blk false;
                };
                if (!stdin_open) stdin_fd = null;
            }
        }

        if (status == null) {
            const res = std.posix.waitpid(pid, std.posix.W.NOHANG);
            if (res.pid != 0) {
                status = res.status;
            }
        }
    }

    if (stdin_fd) |fd| std.posix.close(fd);

    if (status == null) {
        status = std.posix.waitpid(pid, 0).status;
    }

    const term = parseStatus(status.?);
    try sendExecResponse(allocator, virtio_fd, req.id, term.exit_code, term.signal);
}

fn handleStdin(
    allocator: std.mem.Allocator,
    virtio_fd: std.posix.fd_t,
    stdin_fd: std.posix.fd_t,
    expected_id: u32,
) !bool {
    const frame = readFrame(allocator, virtio_fd) catch |err| {
        if (err == error.EndOfStream) {
            std.posix.close(stdin_fd);
            return false;
        }
        return err;
    };
    defer allocator.free(frame);

    var dec = cbor.Decoder.init(allocator, frame);
    const root = try dec.decodeValue();
    defer cbor.freeValue(allocator, root);

    const data = try parseStdinData(root, expected_id);
    if (data.data.len > 0) {
        try writeAll(stdin_fd, data.data);
    }
    if (data.eof) {
        std.posix.close(stdin_fd);
        return false;
    }
    return true;
}

fn parseStatus(status: u32) Termination {
    if (std.posix.W.IFEXITED(status)) {
        return .{ .exit_code = @as(i32, @intCast(std.posix.W.EXITSTATUS(status))), .signal = null };
    }
    if (std.posix.W.IFSIGNALED(status)) {
        const sig = @as(i32, @intCast(std.posix.W.TERMSIG(status)));
        return .{ .exit_code = 128 + sig, .signal = sig };
    }
    return .{ .exit_code = 1, .signal = null };
}

fn buildArgv(
    allocator: std.mem.Allocator,
    cmd: []const u8,
    argv: []const []const u8,
) ![*:null]const ?[*:0]const u8 {
    const total = argv.len + 1;
    const argv_buf = try allocator.allocSentinel(?[*:0]const u8, total, null);
    argv_buf[0] = (try allocator.dupeZ(u8, cmd)).ptr;
    for (argv, 0..) |arg, idx| {
        argv_buf[idx + 1] = (try allocator.dupeZ(u8, arg)).ptr;
    }
    return argv_buf.ptr;
}

fn buildEnvp(
    arena: std.mem.Allocator,
    allocator: std.mem.Allocator,
    env: []const []const u8,
) ![*:null]const ?[*:0]const u8 {
    if (env.len == 0) {
        return std.c.environ;
    }

    var env_map = try std.process.getEnvMap(allocator);
    defer env_map.deinit();

    for (env) |entry| {
        const sep = std.mem.indexOfScalar(u8, entry, '=') orelse return ProtocolError.InvalidValue;
        const key = entry[0..sep];
        const value = entry[sep + 1 ..];
        try env_map.put(key, value);
    }

    const total: usize = @intCast(env_map.count());
    const envp_buf = try arena.allocSentinel(?[*:0]const u8, total, null);

    var it = env_map.iterator();
    var idx: usize = 0;
    while (it.next()) |entry| : (idx += 1) {
        const key = entry.key_ptr.*;
        const value = entry.value_ptr.*;
        const full_len = key.len + 1 + value.len;
        var pair = try arena.alloc(u8, full_len + 1);
        std.mem.copyForwards(u8, pair[0..key.len], key);
        pair[key.len] = '=';
        std.mem.copyForwards(u8, pair[key.len + 1 .. key.len + 1 + value.len], value);
        pair[full_len] = 0;
        envp_buf[idx] = pair[0..full_len :0].ptr;
    }

    return envp_buf.ptr;
}

fn sendExecOutput(
    allocator: std.mem.Allocator,
    virtio_fd: std.posix.fd_t,
    id: u32,
    stream: []const u8,
    data: []const u8,
) !void {
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(allocator);

    const w = buf.writer(allocator);
    try cbor.writeMapStart(w, 4);
    try cbor.writeText(w, "v");
    try cbor.writeUInt(w, 1);
    try cbor.writeText(w, "t");
    try cbor.writeText(w, "exec_output");
    try cbor.writeText(w, "id");
    try cbor.writeUInt(w, id);
    try cbor.writeText(w, "p");
    try cbor.writeMapStart(w, 2);
    try cbor.writeText(w, "stream");
    try cbor.writeText(w, stream);
    try cbor.writeText(w, "data");
    try cbor.writeBytes(w, data);

    try writeFrame(virtio_fd, buf.items);
}

fn sendExecResponse(
    allocator: std.mem.Allocator,
    virtio_fd: std.posix.fd_t,
    id: u32,
    exit_code: i32,
    signal: ?i32,
) !void {
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(allocator);

    const w = buf.writer(allocator);
    const map_len: usize = if (signal == null) 1 else 2;

    try cbor.writeMapStart(w, 4);
    try cbor.writeText(w, "v");
    try cbor.writeUInt(w, 1);
    try cbor.writeText(w, "t");
    try cbor.writeText(w, "exec_response");
    try cbor.writeText(w, "id");
    try cbor.writeUInt(w, id);
    try cbor.writeText(w, "p");
    try cbor.writeMapStart(w, map_len);
    try cbor.writeText(w, "exit_code");
    try cbor.writeInt(w, exit_code);
    if (signal) |sig| {
        try cbor.writeText(w, "signal");
        try cbor.writeInt(w, sig);
    }

    try writeFrame(virtio_fd, buf.items);
}

fn sendError(
    allocator: std.mem.Allocator,
    virtio_fd: std.posix.fd_t,
    id: u32,
    code: []const u8,
    message: []const u8,
) !void {
    var buf = std.ArrayList(u8).empty;
    defer buf.deinit(allocator);

    const w = buf.writer(allocator);
    try cbor.writeMapStart(w, 4);
    try cbor.writeText(w, "v");
    try cbor.writeUInt(w, 1);
    try cbor.writeText(w, "t");
    try cbor.writeText(w, "error");
    try cbor.writeText(w, "id");
    try cbor.writeUInt(w, id);
    try cbor.writeText(w, "p");
    try cbor.writeMapStart(w, 2);
    try cbor.writeText(w, "code");
    try cbor.writeText(w, code);
    try cbor.writeText(w, "message");
    try cbor.writeText(w, message);

    try writeFrame(virtio_fd, buf.items);
}

fn readFrame(allocator: std.mem.Allocator, fd: std.posix.fd_t) ![]u8 {
    var len_buf: [4]u8 = undefined;
    try readExact(fd, len_buf[0..]);

    const len = (@as(u32, len_buf[0]) << 24) |
        (@as(u32, len_buf[1]) << 16) |
        (@as(u32, len_buf[2]) << 8) |
        @as(u32, len_buf[3]);

    const max_frame: u32 = 4 * 1024 * 1024;
    if (len > max_frame) return error.FrameTooLarge;

    const frame = try allocator.alloc(u8, len);
    errdefer allocator.free(frame);
    try readExact(fd, frame);
    return frame;
}

fn readExact(fd: std.posix.fd_t, buf: []u8) !void {
    var offset: usize = 0;
    while (offset < buf.len) {
        const n = try std.posix.read(fd, buf[offset..]);
        if (n == 0) return error.EndOfStream;
        offset += n;
    }
}

fn writeAll(fd: std.posix.fd_t, data: []const u8) !void {
    var offset: usize = 0;
    while (offset < data.len) {
        const n = try std.posix.write(fd, data[offset..]);
        if (n == 0) return error.EndOfStream;
        offset += n;
    }
}

fn writeFrame(fd: std.posix.fd_t, payload: []const u8) !void {
    const len: u32 = @intCast(payload.len);
    var len_buf: [4]u8 = .{
        @intCast((len >> 24) & 0xff),
        @intCast((len >> 16) & 0xff),
        @intCast((len >> 8) & 0xff),
        @intCast(len & 0xff),
    };

    try writeAll(fd, &len_buf);
    try writeAll(fd, payload);
}

fn parseTextArray(allocator: std.mem.Allocator, value: ?cbor.Value) ![]const []const u8 {
    if (value == null) return allocator.alloc([]const u8, 0);
    const items = try expectArray(value.?);
    var out = try allocator.alloc([]const u8, items.len);
    for (items, 0..) |item, idx| {
        out[idx] = try expectText(item);
    }
    return out;
}

fn expectMap(value: cbor.Value) ![]cbor.Entry {
    return switch (value) {
        .Map => |map| map,
        else => ProtocolError.InvalidType,
    };
}

fn expectArray(value: cbor.Value) ![]cbor.Value {
    return switch (value) {
        .Array => |items| items,
        else => ProtocolError.InvalidType,
    };
}

fn expectText(value: cbor.Value) ![]const u8 {
    return switch (value) {
        .Text => |text| text,
        else => ProtocolError.InvalidType,
    };
}

fn expectBytes(value: cbor.Value) ![]const u8 {
    return switch (value) {
        .Bytes => |bytes| bytes,
        else => ProtocolError.InvalidType,
    };
}

fn expectBool(value: cbor.Value) !bool {
    return switch (value) {
        .Bool => |b| b,
        else => ProtocolError.InvalidType,
    };
}

fn expectU32(value: cbor.Value) !u32 {
    return switch (value) {
        .Int => |num| {
            if (num < 0 or num > std.math.maxInt(u32)) return ProtocolError.InvalidValue;
            return @as(u32, @intCast(num));
        },
        else => ProtocolError.InvalidType,
    };
}
