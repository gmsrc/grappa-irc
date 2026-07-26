import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #385 / #409 — the aliases settings sub-page reads the aliasList store
// directly (like WatchlistsSettings). Mock that boundary; assert the VISIBLE
// outcome. #409 adds IN-PLACE edit of an existing alias's name/expansion
// through the store's `editAlias` (one fresh-read-then-PUT), alongside the
// existing add + × remove.

const addAliasMock = vi.fn().mockResolvedValue({});
const delAliasMock = vi.fn().mockResolvedValue({});
const editAliasMock = vi.fn().mockResolvedValue({});
const refreshAliasesMock = vi.fn().mockResolvedValue({});

let aliasData: Record<string, string> = {};

vi.mock("../lib/aliasList", () => ({
  aliases: () => aliasData,
  addAlias: (n: string, e: string) => addAliasMock(n, e),
  delAlias: (n: string) => delAliasMock(n),
  editAlias: (o: string, n: string, e: string) => editAliasMock(o, n, e),
  refreshAliases: () => refreshAliasesMock(),
}));

vi.mock("../lib/friendlyError", () => ({ friendlyError: (e: unknown) => String(e) }));

import AliasSettings from "../AliasSettings";

beforeEach(() => {
  vi.clearAllMocks();
  aliasData = { wii: "whois $1 $1" };
});

describe("AliasSettings in-place edit (#409)", () => {
  it("each alias row exposes an edit button", () => {
    render(() => <AliasSettings onBack={() => {}} />);
    expect(screen.getByRole("button", { name: /edit alias wii/i })).toBeInTheDocument();
  });

  it("clicking edit reveals name + expansion inputs prefilled with current values", () => {
    render(() => <AliasSettings onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /edit alias wii/i }));
    const name = screen.getByTestId("aliases-edit-name") as HTMLInputElement;
    const expansion = screen.getByTestId("aliases-edit-expansion") as HTMLInputElement;
    expect(name.value).toBe("wii");
    expect(expansion.value).toBe("whois $1 $1");
  });

  it("saving an edit calls editAlias(oldName, newName, expansion)", () => {
    render(() => <AliasSettings onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /edit alias wii/i }));
    const name = screen.getByTestId("aliases-edit-name") as HTMLInputElement;
    const expansion = screen.getByTestId("aliases-edit-expansion") as HTMLInputElement;
    fireEvent.input(name, { target: { value: "w" } });
    fireEvent.input(expansion, { target: { value: "whois $1" } });
    fireEvent.submit(name.closest("form") as HTMLFormElement);
    expect(editAliasMock).toHaveBeenCalledWith("wii", "w", "whois $1");
  });

  it("cancel exits edit mode without mutating", () => {
    render(() => <AliasSettings onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /edit alias wii/i }));
    expect(screen.getByTestId("aliases-edit-name")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("aliases-edit-cancel"));
    expect(screen.queryByTestId("aliases-edit-name")).not.toBeInTheDocument();
    expect(editAliasMock).not.toHaveBeenCalled();
  });

  it("save is a no-op when the name or expansion is blank", () => {
    render(() => <AliasSettings onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /edit alias wii/i }));
    const name = screen.getByTestId("aliases-edit-name") as HTMLInputElement;
    fireEvent.input(name, { target: { value: "  " } });
    fireEvent.submit(name.closest("form") as HTMLFormElement);
    expect(editAliasMock).not.toHaveBeenCalled();
  });
});
