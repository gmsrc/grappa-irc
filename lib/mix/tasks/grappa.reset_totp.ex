defmodule Mix.Tasks.Grappa.ResetTotp do
  @shortdoc "Disarms TOTP for a locked-out account"

  @moduledoc """
  Clears the TOTP secret and revokes live sessions for one account,
  restoring password-only login.

      scripts/mix.sh grappa.reset_totp --user alice

  Sibling of `grappa.reset_passkeys`, which covers the passkey side. The
  account recovery codes are shared between the two factors, so they go
  only if this leaves nothing armed to redeem them — disarming one factor
  is not entitled to destroy the other's way back in.
  """
  use Boundary, top_level?: true, deps: [Grappa.Accounts, Mix.Tasks.Grappa.Boot]
  use Mix.Task

  alias Mix.Tasks.Grappa.Boot

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: [user: :string])
    name = Keyword.get(opts, :user) || Mix.raise("--user is required")
    Boot.start_app_silent()

    case Grappa.Accounts.reset_totp(name) do
      {:ok, _} -> IO.puts("disarmed TOTP and revoked sessions for #{name}")
      {:error, :not_found} -> Mix.raise("account not found: #{name}")
      {:error, :db_unavailable} -> Mix.raise("database unavailable")
    end
  end
end
