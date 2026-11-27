//go:build integration_migration_history

package integration_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pressly/goose/v3"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/platform/migrations"
)

// Databases that recorded the mobile migrations under other versions upgrade
// cleanly: the mobile preview desktop build put them at 00894 to 00896, and
// earlier builds of the mobile branch at 00895 to 00899 or 00897 to 00901.
// Goose then skips the main-line migrations that took those numbers, so the
// repair must do what they do, and the renumbered mobile migrations must run
// again harmlessly.
func TestMobileMigrationsUpgradeEarlierVersionHistories(t *testing.T) {
	for _, history := range []struct {
		name string
		// The last main-line version the build ran before its own migrations.
		base int64
		// Its mobile migrations, by current file version, in the order and
		// under the versions it recorded them.
		recorded map[int64]int64
	}{
		{"preview build", 893, map[int64]int64{894: 898, 895: 899, 896: 900}},
		{"earlier branch", 894, map[int64]int64{895: 898, 896: 899, 897: 900, 898: 902, 899: 901}},
		{"branch before templates were dropped", 896, map[int64]int64{897: 898, 898: 899, 899: 900, 900: 902, 901: 901}},
	} {
		t.Run(history.name, func(t *testing.T) {
			ctx := context.Background()
			databaseURL := newEmptyDatabase(t, "mobile_history")
			db := openMigrationTestDatabase(t, databaseURL)
			directory := teamHubMigrationDirectory(t)
			provider, err := goose.NewProvider(goose.DialectPostgres, db, os.DirFS(directory))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := provider.UpTo(ctx, history.base); err != nil {
				t.Fatal(err)
			}
			for version := history.base + 1; version <= history.base+int64(len(history.recorded)); version++ {
				source := history.recorded[version]
				if _, err := db.ExecContext(ctx, upSection(t, directory, source)); err != nil {
					t.Fatalf("apply %d as %d: %v", source, version, err)
				}
				if _, err := db.ExecContext(ctx,
					`INSERT INTO goose_db_version (version_id, is_applied) VALUES ($1, true)`, version); err != nil {
					t.Fatal(err)
				}
			}

			if err := migrations.UpFrom(ctx, databaseURL, directory); err != nil {
				t.Fatal(err)
			}
			for _, check := range []string{
				`SELECT count(*) FROM runtime_local_computers`,
				`SELECT count(*) FROM messages WHERE continues`,
				`SELECT count(*) FROM room_handoff_reports`,
				`SELECT count(*) FROM paired_phones WHERE push_replies`,
				`SELECT count(*) FROM voice_sessions WHERE client = 'mobile'`,
				`SELECT count(*) FROM mobile_relay_nodes`,
			} {
				var count int
				if err := db.QueryRowContext(ctx, check).Scan(&count); err != nil {
					t.Errorf("%s: %v", check, err)
				}
			}
			var templates bool
			if err := db.QueryRowContext(ctx,
				`SELECT to_regclass('agent_templates') IS NOT NULL`).Scan(&templates); err != nil || templates {
				t.Errorf("agent_templates left behind: %v %v", templates, err)
			}
		})
	}
}

// upSection is the SQL a migration file runs on the way up.
func upSection(t *testing.T, directory string, version int64) string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(directory, fmt.Sprintf("%05d_*.sql", version)))
	if err != nil || len(matches) != 1 {
		t.Fatalf("migration %d: %v %v", version, matches, err)
	}
	body, err := os.ReadFile(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	up, _, _ := strings.Cut(string(body), "-- +goose Down")
	return up
}
