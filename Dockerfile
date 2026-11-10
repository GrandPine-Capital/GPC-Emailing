# One image: the dashboard (web/, plain HTML/JS, no build step) is compiled into the Go binary
# (internal/ui), so the service serves the API, the public tracking routes and the pages on
# :8080. For ECS (ValueFarm.Infra staging/emailing.tf); distroless, no shell.

# The build stage runs on the builder's own platform and cross-compiles, so an arm64 Mac (or
# CI) produces the linux/amd64 image ECS runs without emulation.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
ARG TARGETOS=linux
ARG TARGETARCH=amd64
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN rm -rf internal/ui/dist && mkdir -p internal/ui/dist && cp -R web/. internal/ui/dist/
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/emailing ./cmd/emailing

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/emailing /emailing
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/emailing"]
