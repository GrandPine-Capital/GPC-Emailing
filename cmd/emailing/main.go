// Command emailing runs GPC Emailing: the API, the public tracking and webhook routes, the
// dashboard and the background worker, over one Postgres database.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata" // the distroless image has no zoneinfo; auto-reply schedules need it

	"github.com/grandpine-capital/gpc-emailing/internal/app"
	"github.com/grandpine-capital/gpc-emailing/internal/auth"
	"github.com/grandpine-capital/gpc-emailing/internal/config"
	"github.com/grandpine-capital/gpc-emailing/internal/gmail"
	"github.com/grandpine-capital/gpc-emailing/internal/httpapi"
	"github.com/grandpine-capital/gpc-emailing/internal/secretbox"
	"github.com/grandpine-capital/gpc-emailing/internal/store"
	"github.com/grandpine-capital/gpc-emailing/internal/ui"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("emailing stopped", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	box, err := secretbox.New(cfg.SettingsEncryptionKey)
	if err != nil {
		return err
	}
	db, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer db.Close()

	var staff auth.StaffVerifier
	var realm *auth.Keycloak
	switch cfg.AuthMode {
	case "dev":
		log.Warn("AUTH_MODE=dev: the API accepts unsigned dev:<uid>:<access> tokens — never use this outside local development")
		staff = auth.DevVerifier{}
	case "keycloak":
		realm = &auth.Keycloak{Issuer: cfg.KeycloakIssuer, ClientID: cfg.KeycloakClientID, ClientSecret: cfg.KeycloakClientSecret}
		staff = realm
	}
	google := &gmail.OAuth{ClientID: cfg.GoogleClientID, ClientSecret: cfg.GoogleClientSecret, RedirectURL: cfg.PublicBaseURL + "/oauth/google/callback"}
	if !google.Configured() {
		log.Warn("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set: Gmail cannot be connected, so nothing is sent (dry-run mode still works)")
	}
	svc := app.New(db, box, cfg.SettingsEncryptionKey, cfg.PublicBaseURL, google, log)

	if cfg.WorkerEnabled {
		go svc.Run(ctx, cfg.WorkerInterval)
	}

	handler := httpapi.New(httpapi.Deps{Service: svc, Staff: staff, Realm: realm, AuthMode: cfg.AuthMode, AllowedOrigins: cfg.AllowedOrigins, Log: log, UI: ui.Handler()})
	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		// "Check Gmail now" runs the worker for up to 90 seconds.
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  120 * time.Second,
	}
	errc := make(chan error, 1)
	go func() {
		log.Info("emailing listening", "addr", srv.Addr, "env", cfg.Env, "public", cfg.PublicBaseURL, "auth", cfg.AuthMode, "worker", cfg.WorkerEnabled)
		errc <- srv.ListenAndServe()
	}()
	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		log.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
	return nil
}
