defmodule Grappa.Repo.Migrations.AddServicesFlavorToNetworks do
  use Ecto.Migration

  # GH #349 — the network's NickServ services implementation, set by the
  # operator. Drives the cic registration wizard's per-network
  # REGISTER/verify command templates. Nullable string (Ecto.Enum stores
  # the atom as a string): existing rows read `nil` == "unclassified",
  # which the wizard treats identically to `:unknown` (button hidden).
  # Cold deploy — a new column, no backfill.
  def change do
    alter table(:networks) do
      add :services_flavor, :string
    end
  end
end
