defmodule Mix.Tasks.Grappa.ResetPasskeys do
  @shortdoc "Resets passkeys for a locked-out account"

  @moduledoc """
  Removes all passkeys, restores password login, and revokes live sessions
  for one account.

      scripts/mix.sh grappa.reset_passkeys --user alice

  Sibling of `grappa.reset_totp`, which covers the TOTP side. The account
  recovery codes are shared between the two factors, so they go only if
  this leaves nothing armed to redeem them — disarming one factor is not
  entitled to destroy the other's way back in.
  """
  use Boundary, top_level?: true, deps: [Grappa.Accounts, Mix.Tasks.Grappa.Boot]
  use Mix.Task

  alias Mix.Tasks.Grappa.Boot

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: [user: :string])
    name = Keyword.get(opts, :user) || Mix.raise("--user is required")
    Boot.start_app_silent()

    case Grappa.Accounts.reset_passkeys(name) do
      {:ok, _} -> IO.puts("reset passkeys and sessions for #{name}")
      {:error, :not_found} -> Mix.raise("account not found: #{name}")
      {:error, :db_unavailable} -> Mix.raise("database unavailable")
    end
  end
end
