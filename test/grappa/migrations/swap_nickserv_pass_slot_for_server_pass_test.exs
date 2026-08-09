defmodule Grappa.Migrations.SwapNickservPassSlotForServerPassTest do
  @moduledoc """
  GH #1044 — the CONTRACT step (`20260810120000_swap_nickserv_pass_slot_for_server_pass`).

  #124 retired `nickserv_pass_encrypted` expand-only: nothing read or wrote it,
  but the column stayed. This migration drops it and adds an EMPTY
  `server_pass_encrypted` in the same cold window.

  Asserted against the real migrated schema (`PRAGMA table_info`) rather than
  the Ecto struct: the struct reports exactly what the schema module declares,
  which is the thing under test. The DROP is what makes the deletion
  deliberate — on this deployment there was nothing left to carry (measured on
  prod, zero rows), and on an unmeasured self-hosted DB the content is dropped
  rather than silently relabelled as a server `PASS`.
  """
  use Grappa.DataCase, async: true

  alias Grappa.Repo

  defp columns do
    %{rows: rows} = Repo.query!("PRAGMA table_info(network_credentials)")
    MapSet.new(rows, fn row -> Enum.at(row, 1) end)
  end

  describe "the network_credentials secret slots after the swap" do
    test "the retired nickserv_pass_encrypted column is GONE" do
      refute MapSet.member?(columns(), "nickserv_pass_encrypted")
    end

    test "the server PASS slot exists, and the NickServ slot is left where it was" do
      cols = columns()

      assert MapSet.member?(cols, "server_pass_encrypted")
      # The direction #1044 fixed: `password_encrypted` KEEPS the NickServ
      # meaning, because on every visitor row that is what it holds.
      assert MapSet.member?(cols, "password_encrypted")
    end

    test "the new slot starts empty — no data is carried across the rename" do
      %{rows: [[count]]} =
        Repo.query!("SELECT count(*) FROM network_credentials WHERE server_pass_encrypted IS NOT NULL")

      assert count == 0
    end
  end
end
