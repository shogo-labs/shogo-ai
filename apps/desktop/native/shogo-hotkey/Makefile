.PHONY: build build-arm64 build-amd64 build-universal clean

build: build-arm64

build-arm64:
	swift build -c release --arch arm64
	cp .build/release/shogo-hotkey shogo-hotkey-arm64
	codesign --force --sign - shogo-hotkey-arm64

build-amd64:
	swift build -c release --arch x86_64
	cp .build/release/shogo-hotkey shogo-hotkey-amd64
	codesign --force --sign - shogo-hotkey-amd64

build-universal: build-arm64 build-amd64
	lipo -create -output shogo-hotkey-universal shogo-hotkey-arm64 shogo-hotkey-amd64
	codesign --force --sign - shogo-hotkey-universal

clean:
	swift package clean
	rm -f shogo-hotkey-arm64 shogo-hotkey-amd64 shogo-hotkey-universal
