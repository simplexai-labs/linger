package voicedictation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func apiServer(t *testing.T, handler http.HandlerFunc) (*APIPolisher, APIConfig) {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	return NewAPIPolisherWithClient(server.Client()), APIConfig{BaseURL: server.URL + "/v1", Model: "deepseek-chat", Key: "sk-test"}
}

func TestNormalizeAPIBaseURL(t *testing.T) {
	for raw, want := range map[string]string{
		"https://api.deepseek.com/v1":   "https://api.deepseek.com/v1",
		" https://api.deepseek.com/v1/": "https://api.deepseek.com/v1",
		"https://example.com":           "https://example.com",
		"https://8.8.8.8/v1":            "https://8.8.8.8/v1",
	} {
		got, err := NormalizeAPIBaseURL(raw)
		if err != nil || got != want {
			t.Errorf("%q = %q, %v; want %q", raw, got, err, want)
		}
	}
	for _, raw := range []string{
		"", "api.deepseek.com/v1", "http://api.deepseek.com/v1", "ftp://example.com",
		"https://user:pass@example.com/v1", "https://example.com/v1?key=1", "https://example.com/v1#x",
		"https://127.0.0.1/v1", "https://[::1]/v1", "https://10.0.0.5/v1", "https://192.168.1.1/v1",
		"https://169.254.169.254/latest", "https://100.64.0.1/v1", "https://0.0.0.0/v1",
		"https://example.com/" + strings.Repeat("a", 300),
	} {
		if got, err := NormalizeAPIBaseURL(raw); !errors.Is(err, ErrInvalidAPI) {
			t.Errorf("%q must be refused, got %q, %v", raw, got, err)
		}
	}
}

func TestValidAPIModel(t *testing.T) {
	for _, name := range []string{"deepseek-chat", "gpt-4o-mini", "vendor/model:beta"} {
		if !ValidAPIModel(name) {
			t.Errorf("%q is a model name", name)
		}
	}
	for _, name := range []string{"", "a b", "a\nb", strings.Repeat("a", 101)} {
		if ValidAPIModel(name) {
			t.Errorf("%q must not pass as a model name", name)
		}
	}
}

func TestConnectionsRefusePrivateAddresses(t *testing.T) {
	for address, refused := range map[string]bool{
		"8.8.8.8:443": false, "[2606:4700::1]:443": false,
		"127.0.0.1:443": true, "[::1]:443": true, "10.1.2.3:443": true, "172.16.0.1:443": true,
		"192.168.0.1:443": true, "169.254.169.254:80": true, "100.64.0.1:443": true, "0.0.0.0:443": true,
		"[::ffff:127.0.0.1]:443": true, "not an address": true,
	} {
		err := refusePrivateAddress("tcp", address, nil)
		if (err != nil) != refused {
			t.Errorf("%s: err = %v, refused = %v", address, err, refused)
		}
	}
}

func TestTheRealClientNeverConnectsInside(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("a loopback server must not be reached")
	}))
	defer server.Close()
	err := NewAPIPolisher().Probe(context.Background(), APIConfig{BaseURL: server.URL + "/v1", Model: "m", Key: "k"})
	if !errors.Is(err, ErrAPIUnreachable) {
		t.Fatalf("err = %v", err)
	}
}

func TestPolishAsksTheChatAPIForOneRewrite(t *testing.T) {
	var request struct {
		Model    string `json:"model"`
		Messages []struct{ Role, Content string }
		Temp     float64 `json:"temperature"`
	}
	p, config := apiServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Method != http.MethodPost {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer sk-test" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"  Open the file.  "}}]}`))
	})
	text, err := p.Polish(context.Background(), config, "  open the uh file ")
	if err != nil {
		t.Fatal(err)
	}
	if text != "Open the file." {
		t.Fatalf("text = %q", text)
	}
	if request.Model != "deepseek-chat" || request.Temp != 0.3 || len(request.Messages) != 2 ||
		request.Messages[0].Role != "system" || !strings.Contains(request.Messages[0].Content, "Never translate it") ||
		request.Messages[1].Role != "user" || request.Messages[1].Content != "open the uh file" {
		t.Fatalf("request = %+v", request)
	}
}

func TestPolishFailsQuietlyWhenTheAPIDoes(t *testing.T) {
	for name, answer := range map[string]struct {
		status int
		body   string
	}{
		"refused":    {http.StatusUnauthorized, `{"error":"the prompt: open the uh file"}`},
		"overloaded": {http.StatusServiceUnavailable, `busy`},
		"no choices": {http.StatusOK, `{"choices":[]}`},
		"blank":      {http.StatusOK, `{"choices":[{"message":{"content":"  "}}]}`},
		"not JSON":   {http.StatusOK, `ok`},
	} {
		t.Run(name, func(t *testing.T) {
			p, config := apiServer(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(answer.status)
				_, _ = w.Write([]byte(answer.body))
			})
			_, err := p.Polish(context.Background(), config, "open the uh file")
			if err == nil {
				t.Fatal("a failed rewrite must be an error")
			}
			if strings.Contains(err.Error(), "uh file") {
				t.Fatalf("the error repeats the dictated text: %v", err)
			}
		})
	}
}

func TestPolishRejectsAnEmptyOrOversizedPassageWithoutCalling(t *testing.T) {
	p, config := apiServer(t, func(http.ResponseWriter, *http.Request) {
		t.Error("no call for an unusable passage")
	})
	for _, text := range []string{"", "  ", strings.Repeat("a", MaxTextBytes+1)} {
		if _, err := p.Polish(context.Background(), config, text); err == nil {
			t.Fatalf("polished %d bytes", len(text))
		}
	}
}

func TestProbeJudgesTheKeyByTheModelsListing(t *testing.T) {
	for name, answer := range map[string]struct {
		status int
		want   error
	}{
		"accepted":         {http.StatusOK, nil},
		"unauthorized":     {http.StatusUnauthorized, ErrAPIRejected},
		"forbidden":        {http.StatusForbidden, ErrAPIRejected},
		"no listing route": {http.StatusNotFound, nil},
		"server error":     {http.StatusBadGateway, ErrAPIUnreachable},
	} {
		t.Run(name, func(t *testing.T) {
			p, config := apiServer(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer sk-test" {
					t.Errorf("%s %q", r.URL.Path, r.Header.Get("Authorization"))
				}
				w.WriteHeader(answer.status)
			})
			if err := p.Probe(context.Background(), config); !errors.Is(err, answer.want) {
				t.Fatalf("err = %v, want %v", err, answer.want)
			}
		})
	}
}

func TestListModelsReturnsSortedUniqueNames(t *testing.T) {
	p, config := apiServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer sk-test" {
			t.Errorf("%s %q", r.URL.Path, r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"deepseek-chat"},{"id":"a-model"},{"id":"deepseek-chat"},{"id":"has space"},{"id":""},{"object":"model"}]}`))
	})
	names, err := p.ListModels(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 2 || names[0] != "a-model" || names[1] != "deepseek-chat" {
		t.Fatalf("names = %q", names)
	}
}

func TestListModelsCapsALongListing(t *testing.T) {
	var body strings.Builder
	body.WriteString(`{"data":[`)
	for i := 0; i < MaxListedModels+50; i++ {
		if i > 0 {
			body.WriteByte(',')
		}
		fmt.Fprintf(&body, `{"id":"model-%04d"}`, i)
	}
	body.WriteString(`]}`)
	p, config := apiServer(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body.String())) })
	names, err := p.ListModels(context.Background(), config)
	if err != nil || len(names) != MaxListedModels {
		t.Fatalf("%d names, %v", len(names), err)
	}
}

func TestListModelsSaysWhyItCouldNot(t *testing.T) {
	for name, answer := range map[string]struct {
		status int
		body   string
		want   error
	}{
		"unauthorized":     {http.StatusUnauthorized, ``, ErrAPIRejected},
		"forbidden":        {http.StatusForbidden, ``, ErrAPIRejected},
		"server error":     {http.StatusBadGateway, ``, ErrAPIUnreachable},
		"rate limited":     {http.StatusTooManyRequests, ``, ErrAPIUnreachable},
		"not JSON":         {http.StatusOK, `ok`, ErrAPIUnreachable},
		"no listing route": {http.StatusNotFound, ``, nil},
	} {
		t.Run(name, func(t *testing.T) {
			p, config := apiServer(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(answer.status)
				_, _ = w.Write([]byte(answer.body))
			})
			names, err := p.ListModels(context.Background(), config)
			if !errors.Is(err, answer.want) {
				t.Fatalf("err = %v, want %v", err, answer.want)
			}
			if err == nil && (names == nil || len(names) != 0) {
				t.Fatalf("a missing route lists no model, got %q", names)
			}
		})
	}
}

func TestProbeReportsAnUnreachableAPI(t *testing.T) {
	p, config := apiServer(t, func(http.ResponseWriter, *http.Request) {})
	config.BaseURL = "https://127.0.0.1:1/v1"
	if err := p.Probe(context.Background(), config); !errors.Is(err, ErrAPIUnreachable) {
		t.Fatalf("err = %v", err)
	}
}
