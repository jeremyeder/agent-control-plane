package login

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v4"
)

// mintToken builds an unsigned JWT carrying the given exp claim. TokenExpiry
// parses claims without verifying the signature, so an unsigned token is enough.
func mintToken(t *testing.T, exp time.Time) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodNone, jwt.MapClaims{"exp": exp.Unix()})
	s, err := tok.SignedString(jwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("mint token: %v", err)
	}
	return s
}

func TestWriteTokenExpiryNotice(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

	tests := []struct {
		name            string
		hasRefreshToken bool
		accessToken     string
		wantOut         string // substring expected on stdout ("" = expect empty)
		wantErr         string // substring expected on stderr ("" = expect empty)
	}{
		{
			name:            "refresh token present suppresses expiry warning",
			hasRefreshToken: true,
			accessToken:     "", // token irrelevant when a refresh token exists
			wantOut:         "refreshed automatically",
			wantErr:         "",
		},
		{
			name:            "short-lived token without refresh token still warns",
			hasRefreshToken: false,
			accessToken:     "", // set per-case below
			wantErr:         "expires soon",
		},
		{
			name:            "expired token without refresh token warns expired",
			hasRefreshToken: false,
			accessToken:     "", // set per-case below
			wantErr:         "already expired",
		},
		{
			name:            "opaque non-JWT token stays silent",
			hasRefreshToken: false,
			accessToken:     "sha256~abc123",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			token := tc.accessToken
			switch {
			case strings.Contains(tc.name, "short-lived"):
				token = mintToken(t, now.Add(5*time.Minute))
			case strings.Contains(tc.name, "expired token"):
				token = mintToken(t, now.Add(-5*time.Minute))
			}

			var out, errOut bytes.Buffer
			writeTokenExpiryNotice(&out, &errOut, tc.hasRefreshToken, token, now)

			checkContains(t, "stdout", out.String(), tc.wantOut)
			checkContains(t, "stderr", errOut.String(), tc.wantErr)

			// The reassuring info line must never be a scary warning.
			if tc.hasRefreshToken && strings.Contains(out.String()+errOut.String(), "Warning") {
				t.Errorf("did not expect a warning when a refresh token is present, got out=%q err=%q", out.String(), errOut.String())
			}
		})
	}
}

func checkContains(t *testing.T, stream, got, want string) {
	t.Helper()
	if want == "" {
		if got != "" {
			t.Errorf("expected empty %s, got %q", stream, got)
		}
		return
	}
	if !strings.Contains(got, want) {
		t.Errorf("expected %s to contain %q, got %q", stream, want, got)
	}
}
