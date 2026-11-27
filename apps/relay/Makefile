.PHONY: fmt fmt-check vet test build check

fmt:
	gofmt -w cmd internal

fmt-check:
	@unformatted="$$(gofmt -l cmd internal)"; \
	if [ -n "$$unformatted" ]; then \
		echo "The following Go files are not gofmt-formatted:"; \
		printf '%s\n' "$$unformatted"; \
		exit 1; \
	fi

vet:
	go vet ./...

test:
	go test -race -count=1 ./...

build:
	CGO_ENABLED=0 go build -trimpath -o bin/relay ./cmd/relay

check: fmt-check vet test
