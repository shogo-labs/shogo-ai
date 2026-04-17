// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

//go:build darwin

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"sync"
	"syscall"

	"github.com/Code-Hex/vz/v3"
)

func init() {
	runtime.LockOSThread()
}

// JSON-RPC request/response over stdin/stdout
type Request struct {
	ID     int             `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

type Response struct {
	ID     int         `json:"id"`
	Result interface{} `json:"result,omitempty"`
	Error  *string     `json:"error,omitempty"`
}

type VMState struct {
	vm            *vz.VirtualMachine
	vsockDevice   *vz.VirtioSocketDevice
	running       bool
	mu            sync.Mutex
	bridges       map[int]net.Listener // vsock port -> TCP listener
	bridgesMu     sync.Mutex
}

var state VMState

// requestCh delivers parsed JSON-RPC requests from the stdin reader goroutine
// to the main goroutine, which must handle all Virtualization.framework calls.
var requestCh = make(chan Request, 16)

func main() {
	go handleSignals()

	// Read stdin on a separate goroutine
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
		for scanner.Scan() {
			line := scanner.Bytes()
			var req Request
			if err := json.Unmarshal(line, &req); err != nil {
				writeError(0, fmt.Sprintf("invalid JSON: %v", err))
				continue
			}
			requestCh <- req
		}
		close(requestCh)
	}()

	// Process requests on the main thread (required for Virtualization.framework)
	for req := range requestCh {
		handleRequest(req)
	}
}

func handleSignals() {
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	<-sigCh
	stopVM()
	os.Exit(0)
}

func handleRequest(req Request) {
	switch req.Method {
	case "start":
		handleStart(req)
	case "stop":
		handleStop(req)
	case "status":
		handleStatus(req)
	case "forward":
		handleForward(req)
	case "unforward":
		handleUnforward(req)
	default:
		writeError(req.ID, fmt.Sprintf("unknown method: %s", req.Method))
	}
}

type StartParams struct {
	KernelPath    string            `json:"kernelPath"`
	InitrdPath    string            `json:"initrdPath"`
	RootDiskPath  string            `json:"rootDiskPath"`
	SeedISOPath   string            `json:"seedISOPath,omitempty"`
	MemoryMB      uint64            `json:"memoryMB"`
	CPUs          uint              `json:"cpus"`
	Shares        map[string]string `json:"shares"`           // tag -> hostPath
	ReadOnlyShares map[string]string `json:"readOnlyShares"`  // tag -> hostPath
}

func handleStart(req Request) {
	var params StartParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		writeError(req.ID, fmt.Sprintf("invalid start params: %v", err))
		return
	}

	state.mu.Lock()
	defer state.mu.Unlock()

	if state.running {
		writeError(req.ID, "VM already running")
		return
	}

	vm, vsockDev, err := createAndStartVM(params)
	if err != nil {
		writeError(req.ID, fmt.Sprintf("failed to start VM: %v", err))
		return
	}

	state.vm = vm
	state.vsockDevice = vsockDev
	state.running = true
	state.bridges = make(map[int]net.Listener)

	writeResult(req.ID, map[string]interface{}{
		"status": "running",
		"pid":    os.Getpid(),
	})
}

func createAndStartVM(params StartParams) (*vz.VirtualMachine, *vz.VirtioSocketDevice, error) {
	bootLoader, err := vz.NewLinuxBootLoader(
		params.KernelPath,
		vz.WithInitrd(params.InitrdPath),
		vz.WithCommandLine("root=/dev/vda1 console=hvc0 quiet systemd.mask=boot-efi.mount"),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("boot loader: %w", err)
	}

	vmConfig, err := vz.NewVirtualMachineConfiguration(bootLoader, params.CPUs, params.MemoryMB*1024*1024)
	if err != nil {
		return nil, nil, fmt.Errorf("vm config: %w", err)
	}

	// Root disk
	rootDisk, err := vz.NewVirtioBlockDeviceConfiguration(
		mustDiskAttachment(params.RootDiskPath, false),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("root disk: %w", err)
	}
	storageDevices := []vz.StorageDeviceConfiguration{rootDisk}

	// Seed ISO (if provided)
	if params.SeedISOPath != "" {
		seedDisk, err := vz.NewVirtioBlockDeviceConfiguration(
			mustDiskAttachment(params.SeedISOPath, true),
		)
		if err != nil {
			return nil, nil, fmt.Errorf("seed disk: %w", err)
		}
		storageDevices = append(storageDevices, seedDisk)
	}

	vmConfig.SetStorageDevicesVirtualMachineConfiguration(storageDevices)

	// VirtioFS shares
	var fsConfigs []vz.DirectorySharingDeviceConfiguration
	for tag, hostPath := range params.Shares {
		share, err := vz.NewSharedDirectory(hostPath, false)
		if err != nil {
			return nil, nil, fmt.Errorf("share %s: %w", tag, err)
		}
		singleDir, err := vz.NewSingleDirectoryShare(share)
		if err != nil {
			return nil, nil, fmt.Errorf("single dir share %s: %w", tag, err)
		}
		fsDevice, err := vz.NewVirtioFileSystemDeviceConfiguration(tag)
		if err != nil {
			return nil, nil, fmt.Errorf("fs device %s: %w", tag, err)
		}
		fsDevice.SetDirectoryShare(singleDir)
		fsConfigs = append(fsConfigs, fsDevice)
	}
	for tag, hostPath := range params.ReadOnlyShares {
		share, err := vz.NewSharedDirectory(hostPath, true)
		if err != nil {
			continue // skip missing credential dirs
		}
		singleDir, err := vz.NewSingleDirectoryShare(share)
		if err != nil {
			continue
		}
		fsDevice, err := vz.NewVirtioFileSystemDeviceConfiguration(tag)
		if err != nil {
			continue
		}
		fsDevice.SetDirectoryShare(singleDir)
		fsConfigs = append(fsConfigs, fsDevice)
	}
	vmConfig.SetDirectorySharingDevicesVirtualMachineConfiguration(fsConfigs)

	// Vsock
	vsockConfig, err := vz.NewVirtioSocketDeviceConfiguration()
	if err != nil {
		return nil, nil, fmt.Errorf("vsock config: %w", err)
	}
	vmConfig.SetSocketDevicesVirtualMachineConfiguration([]vz.SocketDeviceConfiguration{vsockConfig})

	// Network (NAT)
	natConfig, err := vz.NewNATNetworkDeviceAttachment()
	if err != nil {
		return nil, nil, fmt.Errorf("nat config: %w", err)
	}
	netConfig, err := vz.NewVirtioNetworkDeviceConfiguration(natConfig)
	if err != nil {
		return nil, nil, fmt.Errorf("net config: %w", err)
	}
	vmConfig.SetNetworkDevicesVirtualMachineConfiguration([]*vz.VirtioNetworkDeviceConfiguration{netConfig})

	// Console for kernel output -- use /dev/null for read since stdin is used for JSON-RPC
	devNull, err := os.Open("/dev/null")
	if err != nil {
		return nil, nil, fmt.Errorf("open /dev/null: %w", err)
	}
	serialAttachment, err := vz.NewFileHandleSerialPortAttachment(devNull, os.Stderr)
	if err != nil {
		return nil, nil, fmt.Errorf("serial attachment: %w", err)
	}
	serialPort, err := vz.NewVirtioConsoleDeviceSerialPortConfiguration(serialAttachment)
	if err != nil {
		return nil, nil, fmt.Errorf("serial port: %w", err)
	}
	vmConfig.SetSerialPortsVirtualMachineConfiguration([]*vz.VirtioConsoleDeviceSerialPortConfiguration{serialPort})

	// Entropy
	entropyConfig, err := vz.NewVirtioEntropyDeviceConfiguration()
	if err != nil {
		return nil, nil, fmt.Errorf("entropy: %w", err)
	}
	vmConfig.SetEntropyDevicesVirtualMachineConfiguration([]*vz.VirtioEntropyDeviceConfiguration{entropyConfig})

	valid, err := vmConfig.Validate()
	if err != nil {
		return nil, nil, fmt.Errorf("validation error: %w", err)
	}
	if !valid {
		return nil, nil, fmt.Errorf("invalid VM configuration")
	}

	vm, err := vz.NewVirtualMachine(vmConfig)
	if err != nil {
		return nil, nil, fmt.Errorf("create VM: %w", err)
	}

	if err := vm.Start(); err != nil {
		return nil, nil, fmt.Errorf("start VM: %w", err)
	}

	vsockDevices := vm.SocketDevices()
	if len(vsockDevices) == 0 {
		return nil, nil, fmt.Errorf("no vsock devices found")
	}

	return vm, vsockDevices[0], nil
}

func mustDiskAttachment(path string, readOnly bool) *vz.DiskImageStorageDeviceAttachment {
	// Use cached mode to prevent filesystem corruption and kernel panics on
	// Apple Virtualization.framework. The default (automatic/uncached) mode
	// causes ext4 journal corruption that leads to "corrupted stack end
	// detected inside scheduler" panics. This is the same fix adopted by
	// UTM, Tart, Lima, and Apple Container.
	att, err := vz.NewDiskImageStorageDeviceAttachmentWithCacheAndSync(
		path, readOnly,
		vz.DiskImageCachingModeCached,
		vz.DiskImageSynchronizationModeFull,
	)
	if err != nil {
		panic(fmt.Sprintf("disk attachment %s: %v", path, err))
	}
	return att
}

func handleStop(req Request) {
	state.mu.Lock()
	defer state.mu.Unlock()

	if !state.running {
		writeResult(req.ID, map[string]string{"status": "stopped"})
		return
	}

	stopVM()
	writeResult(req.ID, map[string]string{"status": "stopped"})
}

func stopVM() {
	if state.vm == nil {
		return
	}

	// Close all bridges
	state.bridgesMu.Lock()
	for port, listener := range state.bridges {
		listener.Close()
		delete(state.bridges, port)
	}
	state.bridgesMu.Unlock()

	if state.vm.CanRequestStop() {
		_, _ = state.vm.RequestStop()
	} else {
		_ = state.vm.Stop()
	}

	state.running = false
	state.vm = nil
	state.vsockDevice = nil
}

func handleStatus(req Request) {
	state.mu.Lock()
	defer state.mu.Unlock()

	status := "stopped"
	if state.running {
		status = "running"
	}
	writeResult(req.ID, map[string]string{"status": status})
}

type ForwardParams struct {
	VsockPort int `json:"vsockPort"`
	HostPort  int `json:"hostPort"`
}

func handleForward(req Request) {
	var params ForwardParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		writeError(req.ID, fmt.Sprintf("invalid forward params: %v", err))
		return
	}

	state.mu.Lock()
	if !state.running || state.vsockDevice == nil {
		state.mu.Unlock()
		writeError(req.ID, "VM not running")
		return
	}
	vsockDev := state.vsockDevice
	state.mu.Unlock()

	state.bridgesMu.Lock()
	if _, exists := state.bridges[params.VsockPort]; exists {
		state.bridgesMu.Unlock()
		writeError(req.ID, fmt.Sprintf("vsock port %d already forwarded", params.VsockPort))
		return
	}
	state.bridgesMu.Unlock()

	listener, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(params.HostPort))
	if err != nil {
		writeError(req.ID, fmt.Sprintf("listen on host port %d: %v", params.HostPort, err))
		return
	}

	state.bridgesMu.Lock()
	state.bridges[params.VsockPort] = listener
	state.bridgesMu.Unlock()

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return // listener closed
			}
			go bridgeConnection(conn, vsockDev, uint32(params.VsockPort))
		}
	}()

	writeResult(req.ID, map[string]interface{}{
		"vsockPort": params.VsockPort,
		"hostPort":  params.HostPort,
	})
}

func bridgeConnection(tcpConn net.Conn, vsockDev *vz.VirtioSocketDevice, port uint32) {
	defer tcpConn.Close()

	vsockConn, err := vsockDev.Connect(port)
	if err != nil {
		return
	}
	defer vsockConn.Close()

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		io.Copy(vsockConn, tcpConn)
	}()
	go func() {
		defer wg.Done()
		io.Copy(tcpConn, vsockConn)
	}()

	wg.Wait()
}

type UnforwardParams struct {
	VsockPort int `json:"vsockPort"`
}

func handleUnforward(req Request) {
	var params UnforwardParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		writeError(req.ID, fmt.Sprintf("invalid unforward params: %v", err))
		return
	}

	state.bridgesMu.Lock()
	listener, exists := state.bridges[params.VsockPort]
	if exists {
		listener.Close()
		delete(state.bridges, params.VsockPort)
	}
	state.bridgesMu.Unlock()

	if !exists {
		writeError(req.ID, fmt.Sprintf("vsock port %d not forwarded", params.VsockPort))
		return
	}

	writeResult(req.ID, map[string]string{"status": "removed"})
}

var writeMu sync.Mutex

func writeResult(id int, result interface{}) {
	resp := Response{ID: id, Result: result}
	writeMu.Lock()
	defer writeMu.Unlock()
	data, _ := json.Marshal(resp)
	fmt.Fprintf(os.Stdout, "%s\n", data)
}

func writeError(id int, msg string) {
	resp := Response{ID: id, Error: &msg}
	writeMu.Lock()
	defer writeMu.Unlock()
	data, _ := json.Marshal(resp)
	fmt.Fprintf(os.Stdout, "%s\n", data)
}
