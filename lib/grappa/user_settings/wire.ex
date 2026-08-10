defmodule Grappa.UserSettings.Wire do
  @moduledoc """
  Single source of truth for the public JSON wire shape of the per-user
  settings pushes (#348).

  One door emits this contract today: `Grappa.UserSettings`, after a
  successful write, broadcasts on `Grappa.PubSub.Topic.user/1` so the
  subject's OTHER devices mirror a change made on one of them. The REST
  response of the same write carries the identical scalar — one shape,
  two doors, per the CLAUDE.md "one feature, one code path, every door"
  rule.

  ## One event per setting, not one `settings_changed` for all

  A generic "your settings changed" push would either carry the whole
  settings blob (leaking every other key on every write) or carry
  nothing and force a re-fetch. A narrow, additive event per setting
  keeps each payload honest about what actually moved; the wire contract
  is additive-only (#447), so a second setting is a second `kind`, never
  a repurposed field.

  ## The `0` sentinel

  `Grappa.UserSettings.auto_away_debounce/0` is `nil | :disabled |
  pos_integer()`. JSON has no atoms, so `:disabled` travels as `0` —
  the same encoding `GrappaWeb.UserSettingsJSON` renders on the REST
  side. `null` stays "no preference, the server default applies".
  """

  use Boundary, top_level?: true, deps: []

  alias Grappa.UserSettings

  @typedoc """
  Wire shape of the `auto_away_debounce_changed` push (#348).

  `auto_away_debounce_seconds`: `null` = no preference, `0` = auto-away
  off, any other integer = seconds.
  """
  @type auto_away_debounce_changed_payload :: %{
          kind: :auto_away_debounce_changed,
          auto_away_debounce_seconds: non_neg_integer() | nil
        }

  @doc """
  Builds the `auto_away_debounce_changed` push payload from the stored
  preference.

  The atom `kind` is passed through unchanged: `Jason.encode!/1`
  stringifies it at the JSON edge while `mix grappa.gen_wire_types`
  emits the literal string union cic asserts against (the
  `Grappa.ServerSettings.Wire` precedent).
  """
  @spec auto_away_debounce_changed(UserSettings.auto_away_debounce()) ::
          auto_away_debounce_changed_payload()
  def auto_away_debounce_changed(:disabled),
    do: %{kind: :auto_away_debounce_changed, auto_away_debounce_seconds: 0}

  def auto_away_debounce_changed(seconds)
      when is_nil(seconds) or is_integer(seconds),
      do: %{kind: :auto_away_debounce_changed, auto_away_debounce_seconds: seconds}
end
