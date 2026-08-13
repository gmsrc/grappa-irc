defmodule Grappa.Repo.Migrations.AddProviderToPushSubscriptions do
  @moduledoc """
  UnifiedPush support — adds a `provider` discriminator
  (`"webpush"` | `"unifiedpush"`, default `"webpush"` for every
  existing row) to `push_subscriptions`.

  ## Why `p256dh_key` / `auth_key` are untouched

  A UnifiedPush registration carries a real P-256 keypair + auth
  secret too, generated client-side the same way a browser's
  `PushManager.subscribe()` does internally for Web Push — so
  `Grappa.Push.Sender` sends the IDENTICAL VAPID-signed `aes128gcm`
  encrypted POST for both providers, unbranched (see
  `Grappa.Push.Sender`'s moduledoc, "`:provider` (2026-08-13,
  UnifiedPush)"). `provider` exists purely to let a client's device
  list ("see + revoke my devices", B3) show what KIND of device each
  row is; it changes no delivery behavior and no column requirement,
  so this migration only ever ADDs a column.

  ## A plain `ADD COLUMN`, not the recreate dance — and no DB-level CHECK

  Unlike `20260515005116_xor_fk_push_subscriptions` (which relaxed a
  `NOT NULL` — something SQLite's `ALTER TABLE` cannot express and
  forces a rename+recreate+copy), a new column with a literal
  `DEFAULT` is exactly what SQLite's native `ALTER TABLE ADD COLUMN`
  supports directly. No table recreation needed here — and SQLite's
  `ALTER TABLE` cannot add a CHECK constraint to an existing table
  either (confirmed: `ecto_sqlite3` raises `ArgumentError` on it), so
  unlike `:subject`'s DB-enforced XOR, `provider`'s closed set is
  validated ONLY at the Ecto layer — `field :provider, Ecto.Enum,
  values: [:webpush, :unifiedpush]` in
  `Grappa.Push.Subscription`'s schema, which rejects anything
  outside the set on `cast/3` the same way `validate_inclusion/3`
  would, with no DB CHECK needed. Every insert/update in this
  codebase already routes through that schema.

  ## Hot-safe (unlike its siblings)

  A bare `alter table do add :column, :type, default: ... end` is
  the textbook expand op `Grappa.Deploy.Preflight`'s classifier
  allowlists as `:hot` — the currently-loaded BEAM code, which knows
  nothing about the new `provider` column yet, keeps running
  correctly against the altered table (it simply never reads or
  writes the column until the next deploy's code catches up). This
  migration is the reason it is safe to say so: unlike
  `20260515005116_xor_fk_push_subscriptions` (a `NOT NULL` relax,
  forced into the rename+recreate+copy dance and therefore `:cold`),
  this one adds nothing the running code depends on and drops
  nothing the running code reads — no window where the table
  doesn't exist under its live name, no shape the old code would
  choke on.
  """
  use Ecto.Migration

  def change do
    alter table(:push_subscriptions) do
      add :provider, :text, null: false, default: "webpush"
    end
  end
end
