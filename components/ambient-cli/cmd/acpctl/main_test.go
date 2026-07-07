package main

import "testing"

func TestRootCommandRegistersTUIWithoutAmbientAlias(t *testing.T) {
	tuiFound := false

	for _, cmd := range root.Commands() {
		if cmd.Name() == "ambient" {
			t.Fatal("root command must not register the old TUI command name")
		}
		for _, alias := range cmd.Aliases {
			if alias == "ambient" {
				t.Fatalf("command %q must not keep ambient as an alias", cmd.Name())
			}
		}
		if cmd.Name() == "tui" {
			tuiFound = true
		}
	}

	if !tuiFound {
		t.Fatal("root command must register acpctl tui")
	}
}
