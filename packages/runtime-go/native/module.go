package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// The hosts that run a session one after the other share its scratch
// directory for Go, where each keeps its session's module, every cell's
// plugin in it, in a directory of its own, <pid>-<random>/, which it makes.
// No host removes a module, its own or another's, however it ends: a sandbox
// saved live and restored runs the hosts the save caught, which map the
// plugins of their modules, so the modules stay on disk until the server
// removes them, once the state generation that no such save outlives is on
// disk: a host's, after the host has ended, as it is recycled or its session
// quarantined, and all of them as the server closes the session or starts
// afresh. A module is a few MB per cell, kept so for its host's life.

// moduleTries is how many names claimModule tries before it gives up.
const moduleTries = 8

// claimModule makes the directory of this host's module in scratch, under a
// name no other host's module has had: the host's pid and random bits, made
// anew should another host have the name already, as one of the same pid may.
func claimModule(scratch string, pid int) (string, error) {
	if err := os.MkdirAll(scratch, 0o755); err != nil {
		return "", err
	}
	for range moduleTries {
		var suffix [8]byte
		if _, err := rand.Read(suffix[:]); err != nil {
			return "", err
		}
		dir := filepath.Join(scratch, fmt.Sprintf("%d-%s", pid, hex.EncodeToString(suffix[:])))
		err := os.Mkdir(dir, 0o755)
		if err == nil {
			return dir, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return "", err
		}
	}
	return "", fmt.Errorf("no name of a module of the host %d in %s is free after %d tries", pid, scratch, moduleTries)
}
