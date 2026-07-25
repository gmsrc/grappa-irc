defmodule Grappa.Session.PerformListTest do
  @moduledoc """
  #189 — pure expansion of the on-connect perform list. `expand/2` turns the
  stored free text into the executable wire lines: skips blank + `#`-comment
  lines, substitutes `$nickserv_pass` / `$oper_pass`, and reports the
  STRUCTURAL suppression signal `consumed_nickserv_pass?` (did an EXECUTED
  line actually substitute the NickServ password) so the caller can skip the
  built-in identify without ever text-scanning for identify verbs.
  """
  use ExUnit.Case, async: true

  alias Grappa.Session.PerformList

  @secrets %{nickserv_pass: "nspw", oper_pass: "oppw"}

  describe "expand/2" do
    test "nil / blank text yields no lines and consumes nothing" do
      assert %{lines: [], consumed_nickserv_pass?: false} = PerformList.expand(nil, @secrets)
      assert %{lines: [], consumed_nickserv_pass?: false} = PerformList.expand("", @secrets)
      assert %{lines: [], consumed_nickserv_pass?: false} = PerformList.expand("   \n\n", @secrets)
    end

    test "substitutes both variables and reports the raw (unexpanded) form for logging" do
      %{lines: lines, consumed_nickserv_pass?: consumed?} =
        PerformList.expand("NS IDENTIFY $nickserv_pass\nOPER vjt $oper_pass", @secrets)

      assert consumed?

      assert lines == ["NS IDENTIFY nspw", "OPER vjt oppw"]
    end

    test "skips blank lines and #-comment lines" do
      %{lines: lines} =
        PerformList.expand("# on-connect\n\nMODE $nick +x\n   # indented comment\n", @secrets)

      assert lines == ["MODE $nick +x"]
    end

    test "a $nickserv_pass inside a COMMENTED line does NOT count as consumed" do
      %{lines: lines, consumed_nickserv_pass?: consumed?} =
        PerformList.expand("# NS IDENTIFY $nickserv_pass\nMODE $nick +x", @secrets)

      refute consumed?
      assert lines == ["MODE $nick +x"]
    end

    test "no $nickserv_pass reference means not consumed, even if oper_pass is used" do
      %{lines: lines, consumed_nickserv_pass?: consumed?} =
        PerformList.expand("OPER vjt $oper_pass", @secrets)

      refute consumed?
      assert lines == ["OPER vjt oppw"]
    end

    test "trims trailing whitespace / CR and handles CRLF line endings" do
      %{lines: lines} = PerformList.expand("MODE $nick +x  \r\nWHOIS me\r\n", @secrets)

      assert lines == ["MODE $nick +x", "WHOIS me"]
    end

    test "a substituted secret is not re-scanned for variables (single-pass)" do
      %{lines: lines} =
        PerformList.expand("OPER vjt $oper_pass", %{nickserv_pass: "x", oper_pass: "a$nickserv_pass"})

      # The literal '$nickserv_pass' inside the oper password value stays verbatim.
      assert lines == ["OPER vjt a$nickserv_pass"]
    end

    test "a missing nickserv_pass value never leaks the literal token and is not consumed" do
      %{lines: lines, consumed_nickserv_pass?: consumed?} =
        PerformList.expand("NS IDENTIFY $nickserv_pass", %{nickserv_pass: nil, oper_pass: nil})

      refute consumed?
      assert lines == ["NS IDENTIFY "]
    end
  end
end
