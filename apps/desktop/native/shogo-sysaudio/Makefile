.PHONY: build build-arm64 build-amd64 build-universal clean

ENTITLEMENTS := entitlements.plist

build: build-arm64

build-arm64:
	swift build -c release --arch arm64
	cp .build/release/shogo-sysaudio shogo-sysaudio-arm64
	codesign --force --sign - --entitlements $(ENTITLEMENTS) shogo-sysaudio-arm64

build-amd64:
	swift build -c release --arch x86_64
	cp .build/release/shogo-sysaudio shogo-sysaudio-amd64
	codesign --force --sign - --entitlements $(ENTITLEMENTS) shogo-sysaudio-amd64

build-universal: build-arm64 build-amd64
	lipo -create -output shogo-sysaudio-universal shogo-sysaudio-arm64 shogo-sysaudio-amd64
	codesign --force --sign - --entitlements $(ENTITLEMENTS) shogo-sysaudio-universal

clean:
	swift package clean
	rm -f shogo-sysaudio-arm64 shogo-sysaudio-amd64 shogo-sysaudio-universal
