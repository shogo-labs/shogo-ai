.PHONY: build build-arm64 build-amd64 clean

ENTITLEMENTS := entitlements.plist

build: build-arm64

build-arm64:
	CGO_ENABLED=1 GOOS=darwin GOARCH=arm64 go build -o shogo-vm-arm64 .
	codesign --force --sign - --entitlements $(ENTITLEMENTS) shogo-vm-arm64

build-amd64:
	CGO_ENABLED=1 GOOS=darwin GOARCH=amd64 go build -o shogo-vm-amd64 .
	codesign --force --sign - --entitlements $(ENTITLEMENTS) shogo-vm-amd64

build-all: build-arm64 build-amd64

clean:
	rm -f shogo-vm-arm64 shogo-vm-amd64
