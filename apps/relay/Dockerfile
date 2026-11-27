# Build context: apps/relay. The module has no replace directives, so it builds
# on its own.
FROM golang:1.26.5 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/relay ./cmd/relay

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/relay /relay
USER nonroot:nonroot
EXPOSE 8090
ENTRYPOINT ["/relay"]
