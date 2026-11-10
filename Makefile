# Local development. Postgres: docker compose, or any local server with DATABASE_URL set.
.PHONY: run test web build migrate

run: web ## the service with the dashboard embedded; reads .env
	set -a; [ -f .env ] && . ./.env; set +a; go run ./cmd/emailing

test: ## Go tests (Postgres ones need TEST_DATABASE_URL) and the dashboard's shared JS
	go vet ./... && go test -count=1 ./...
	node --test "test/**/*.test.js"

web: ## copy the dashboard where the Go binary embeds it
	rm -rf internal/ui/dist && mkdir -p internal/ui/dist && cp -R web/. internal/ui/dist/ && touch internal/ui/dist/.gitkeep

build: web
	CGO_ENABLED=0 go build -trimpath -o bin/emailing ./cmd/emailing

migrate: ## Flyway against docker-compose's Postgres
	docker run --rm --network host -v "$(PWD)/db/migration:/flyway/sql:ro" -v "$(PWD)/db/flyway.conf:/flyway/conf/flyway.conf:ro" \
	  flyway/flyway:11 -configFiles=/flyway/conf/flyway.conf -locations=filesystem:/flyway/sql \
	  -url=jdbc:postgresql://localhost:5432/gpc_emailing -user=emailing -password=emailing migrate
