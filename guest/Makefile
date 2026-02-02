.PHONY: build test clean run image kernel qemu

ZIG ?= zig
OPTIMIZE ?= ReleaseSmall

IMAGE_SCRIPT ?= ./image/build.sh
IMAGE_OUT ?= ./image/out
IMAGE_INITRAMFS ?= $(IMAGE_OUT)/initramfs.cpio.gz

ALPINE_BRANCH ?= v3.20
ALPINE_ARCH ?= x86_64
ALPINE_MIRROR ?= https://dl-cdn.alpinelinux.org/alpine
KERNEL_PKG ?= linux-virt
KERNEL ?= $(IMAGE_OUT)/vmlinuz-virt

QEMU ?= qemu-system-x86_64
QEMU_MEMORY ?= 256M
QEMU_SMP ?= 1
QEMU_SERIAL ?= stdio
QEMU_WAIT ?= on
VIRTIO_SOCK ?= $(IMAGE_OUT)/virtio.sock

build:
	$(ZIG) build -Doptimize=$(OPTIMIZE)

run: build
	./zig-out/bin/sandboxd

image: build
	$(IMAGE_SCRIPT)

kernel:
	@set -e; \
		mkdir -p $(IMAGE_OUT); \
		if [ -f "$(KERNEL)" ]; then \
			echo "Kernel already present at $(KERNEL)"; \
			exit 0; \
		fi; \
		echo "Fetching $(KERNEL_PKG) from Alpine $(ALPINE_BRANCH) ($(ALPINE_ARCH))"; \
		index_url=$(ALPINE_MIRROR)/$(ALPINE_BRANCH)/main/$(ALPINE_ARCH)/APKINDEX.tar.gz; \
		if [ ! -f "$(IMAGE_OUT)/APKINDEX.tar.gz" ]; then \
			echo "Downloading $$index_url"; \
			curl -L -o "$(IMAGE_OUT)/APKINDEX.tar.gz" "$$index_url"; \
		fi; \
		tar -xzf "$(IMAGE_OUT)/APKINDEX.tar.gz" -C "$(IMAGE_OUT)" APKINDEX; \
		ver=$$(awk '/^P:$(KERNEL_PKG)$$/{p=1} p&&/^V:/{print substr($$0,3); exit}' "$(IMAGE_OUT)/APKINDEX"); \
		rm -f "$(IMAGE_OUT)/APKINDEX"; \
		if [ -z "$$ver" ]; then \
			echo "failed to determine $(KERNEL_PKG) version" >&2; \
			exit 1; \
		fi; \
		apk_url="$(ALPINE_MIRROR)/$(ALPINE_BRANCH)/main/$(ALPINE_ARCH)/$(KERNEL_PKG)-$$ver.apk"; \
		echo "Downloading $$apk_url"; \
		curl -L -o "$(IMAGE_OUT)/$(KERNEL_PKG).apk" "$$apk_url"; \
		tar -xzf "$(IMAGE_OUT)/$(KERNEL_PKG).apk" -C "$(IMAGE_OUT)" boot/vmlinuz-virt; \
		mv "$(IMAGE_OUT)/boot/vmlinuz-virt" "$(KERNEL)"; \
		rm -rf "$(IMAGE_OUT)/boot"

qemu: image kernel
	@rm -f $(VIRTIO_SOCK)
	$(QEMU) \
		-nodefaults -no-reboot -m $(QEMU_MEMORY) -smp $(QEMU_SMP) \
		-kernel $(KERNEL) \
		-initrd $(IMAGE_INITRAMFS) \
		-append "console=ttyS0" \
		-nographic \
		-serial $(QEMU_SERIAL) \
		-object rng-random,filename=/dev/urandom,id=rng0 \
		-device virtio-rng-pci,rng=rng0 \
		-chardev socket,id=virtiocon0,path=$(VIRTIO_SOCK),server=on,wait=$(QEMU_WAIT) \
		-device virtio-serial-pci \
		-device virtserialport,chardev=virtiocon0,name=virtio-port

test:
	$(ZIG) build test -Doptimize=$(OPTIMIZE)

clean:
	rm -rf zig-cache zig-out
