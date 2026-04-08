.PHONY: build build-arm64 build-amd64 build-all clean

ENTITLEMENTS := entitlements.plist

build: build-arm64

build-arm64:
	swift build -c release --arch arm64
	cp .build/release/shogo-audio shogo-audio-arm64
	codesign --force --sign - --entitlements $(ENTITLEMENTS) shogo-audio-arm64

build-amd64:
	swift build -c release --arch x86_64
	cp .build/release/shogo-audio shogo-audio-amd64
	codesign --force --sign - --entitlements $(ENTITLEMENTS) shogo-audio-amd64

build-all: build-arm64 build-amd64

clean:
	swift package clean
	rm -f shogo-audio-arm64 shogo-audio-amd64
