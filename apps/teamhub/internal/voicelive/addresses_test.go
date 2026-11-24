package voicelive

import "testing"

// Misheard recipients resemble a known address in the part before @, in the
// domain, or in both; addresses like none of the known ones stay as heard.
func TestSuggestRecipientsComparesNameAndDomainApart(t *testing.T) {
	known := []string{"Zhengchen@simplexai.com", "zhengc1018@163.com", "zhangboknight@gmail.com", "zhengc1018@gmail.com"}
	for _, check := range []struct{ heard, suggested string }{
		{"zhenzhu@syntaxai.com", "Zhengchen@simplexai.com"},
		{"zhengchun@simplexai.com", "Zhengchen@simplexai.com"},
		{"zhenzhen@simplexai.com", "Zhengchen@simplexai.com"},
		{"zhengchun@singjackci.com", "Zhengchen@simplexai.com"},
		{"zhengchen@gmail.com", "Zhengchen@simplexai.com"},
		{"xxx@simpla.com", "xxx@simplexai.com"},
		{"lisa@simplex.com", "lisa@simplexai.com"},
		{"lisa@simplexai.co", "lisa@simplexai.com"},
		{"bob@gmial.com", "bob@gmail.com"},
		{"bob@136.com", "bob@163.com"},
		{"zhengchen@simplexai.com", ""},
		{"xxx@simplexai.com", ""},
		{"lisa@syntaxai.com", ""},
		{"zhangsan@gmail.com", ""},
		{"john.doe@acme.com", ""},
		{"amy@sina.com", ""},
		{"amy@apple.com", ""},
		{"amy@syntax.ai", ""},
		{"amy@qq.com", ""},
		{"amy@simplexai.org", ""},
		{"amy@simplexai.cn", ""},
	} {
		got := SuggestRecipients(check.heard, "", known)
		suggested := ""
		if len(got) == 1 {
			suggested = got[0].Suggested
		}
		if len(got) > 1 || suggested != check.suggested {
			t.Errorf("%s: got %+v, want %q", check.heard, got, check.suggested)
		}
	}
}

func TestSuggestRecipientsCoversToAndCcOnce(t *testing.T) {
	known := []string{"amy.chen@northwind.io"}
	got := SuggestRecipients("amy.chan@northwind.io, kevin@acme.com", "AMY.CHAN@northwind.io; lee@northwin.io", known)
	if len(got) != 2 || got[0] != (RecipientSuggestion{"amy.chan@northwind.io", "amy.chen@northwind.io"}) ||
		got[1] != (RecipientSuggestion{"lee@northwin.io", "lee@northwind.io"}) {
		t.Fatalf("got %+v", got)
	}
	if got := SuggestRecipients("not an address", "", known); got != nil {
		t.Fatalf("malformed got %+v", got)
	}
	if got := SuggestRecipients("amy@x.io", "", nil); got != nil {
		t.Fatalf("no known got %+v", got)
	}
}
