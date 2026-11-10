// Package ui serves the dashboard (web/, copied to dist/ by `make web` and the Dockerfile).
// Files are revalidated on every load and every other path is index.html, never cached, so a
// release shows at once.
package ui

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:dist
var dist embed.FS

// Handler serves the app; nil when no build is embedded (a bare `go run`).
func Handler() http.Handler {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		return nil
	}
	index, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		return nil
	}
	files := http.FS(sub)
	fileServer := http.FileServer(files)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "+
			"font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https:; frame-src 'self'; "+
			"frame-ancestors 'none'; form-action 'self' https:; base-uri 'self'; object-src 'none'")
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path != "" && path != "index.html" {
			if f, err := files.Open("/" + path); err == nil {
				st, _ := f.Stat()
				f.Close()
				if st != nil && !st.IsDir() {
					if strings.HasPrefix(path, "assets/") {
						h.Set("Cache-Control", "public, max-age=31536000, immutable")
					} else {
						h.Set("Cache-Control", "no-cache")
					}
					fileServer.ServeHTTP(w, r)
					return
				}
			}
		}
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Cache-Control", "no-cache, no-store, must-revalidate")
		_, _ = w.Write(index)
	})
}
