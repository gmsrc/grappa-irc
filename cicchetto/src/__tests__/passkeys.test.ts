import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPasskey, getPasskey, passkeysAvailable } from "../lib/passkeys";

// #736 — `lib/passkeys.ts` is the ONE place the snake_case wire meets the
// camelCase WebAuthn API, and the ONE place base64url ⇄ ArrayBuffer conversion
// happens. Both are silent-corruption candidates: a wrong alphabet swap or a
// dropped `=` pad yields a well-formed buffer of the WRONG bytes, so the
// ceremony fails at the authenticator (or, worse, verifies against a different
// challenge) with nothing in the UI naming the cause. Nothing else in the app
// would notice a mistranslation, so these assert the exact object the browser
// API is handed.
//
// jsdom ships no `navigator.credentials`, so the ceremony is faked at that
// exact boundary — everything above it (both conversions, both option
// rebuilds, both cancel guards) is the real module.
//
// #1582 — merged from a second file testing this same module. The two
// overlapped in SUBSTANCE and diverged in VOCABULARY ("hands the browser the
// camelCase shape with decoded buffers" versus "rebuilds the wire options into
// the camelCase WebAuthn shape"), but MEASURED neither pair was byte-identical
// nor did either member strictly dominate the other — each asserted fields the
// other did not (`challenge` bytes on one side, `user.name` / `attestation` /
// `excludeCredentials` on the other). So every case survives: the rule is that
// a case vanishes only when it is byte-identical to a survivor or strictly
// weaker than one, and "reads like a paraphrase" is neither.
//
// What DID collapse is the plumbing. The two files installed the fake
// `navigator.credentials` two different ways — one replacing the whole
// `navigator` global via `vi.stubGlobal`, one defining the property on the
// real one and deleting it after. The DELETING shape wins: jsdom's baseline is
// an ABSENT property and #725's feature detection probes for exactly that, so
// the no-WebAuthn cases below now run against a real navigator missing
// `credentials` — which IS the plain-http condition they exist for — instead
// of a `{}` stand-in that also leaked into every later case in the file.

const b64 = (bytes: number[]): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const definedOr = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`expected ${what}`);
  return value;
};

// Handles a VIEW as well as a bare ArrayBuffer: `new Uint8Array(view)` would
// read the view's whole backing buffer, silently returning the wrong bytes for
// any subarray the WebAuthn shim ever hands back.
const bytesOf = (buffer: BufferSource | undefined): number[] => {
  const b = definedOr(buffer, "a buffer");
  return Array.from(
    b instanceof ArrayBuffer
      ? new Uint8Array(b)
      : new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
  );
};

const publicKeyOf = <T>(options: unknown): T =>
  definedOr((options as { publicKey?: T }).publicKey, "the credentials call to carry a publicKey");

const optionsGivenTo = <T>(spy: ReturnType<typeof vi.fn>): T =>
  publicKeyOf<T>(
    definedOr(spy.mock.calls[0], "the browser credentials API to have been called")[0],
  );

// The default credential every case gets unless it installs its own: a shape
// complete enough that both ceremonies run to their end, so a case that only
// cares about the options HANDED IN does not have to describe a response.
const credentialStub = {
  rawId: new Uint8Array([9, 9]).buffer,
  response: {
    attestationObject: new Uint8Array([1]).buffer,
    clientDataJSON: new Uint8Array([2]).buffer,
    authenticatorData: new Uint8Array([3]).buffer,
    signature: new Uint8Array([4]).buffer,
    userHandle: null,
    getTransports: () => ["usb"],
  },
};

const credentials = { create: vi.fn(), get: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  // Re-arms the implementation too (`mockResolvedValue` replaces it), so a
  // `mockImplementation` installed by one case cannot leak into the next.
  credentials.create.mockResolvedValue(credentialStub);
  credentials.get.mockResolvedValue(credentialStub);
  Object.defineProperty(navigator, "credentials", { value: credentials, configurable: true });
});

afterEach(() => {
  // Delete rather than set-undefined: jsdom's baseline is an ABSENT
  // property, and #725's feature detection probes for exactly that.
  Reflect.deleteProperty(navigator, "credentials");
});

const requestOptions = (overrides: Record<string, unknown>) => ({
  challenge_id: "challenge-1",
  public_key: { challenge: "AQIDBA", rp_id: "grappa.example", ...overrides },
});

const creationOptions = (overrides: Record<string, unknown>) => ({
  challenge_id: "challenge-1",
  public_key: {
    challenge: "AQIDBA",
    rp: { id: "grappa.example", name: "Grappa" },
    user: { id: "dXNlcg", name: "alice", display_name: "Alice L" },
    pub_key_cred_params: [{ type: "public-key", alg: -7 }],
    ...overrides,
  },
});

// #725 — `CredentialsContainer` is [SecureContext]-only, so on a plain-http
// deployment (grappa is self-hosted; an operator on `http://192.168.1.10` is
// a supported reality) `navigator.credentials` is `undefined` and both entry
// points threw `TypeError: undefined is not an object (evaluating
// 'navigator.credentials.get')` — a JavaScript internal printed verbatim on
// the login card and in the settings pane.
describe("an origin or browser without WebAuthn", () => {
  const refusalFrom = async (run: () => Promise<unknown>): Promise<unknown> =>
    run().then(
      () => {
        throw new Error("expected the ceremony to be refused");
      },
      (value: unknown) => value,
    );

  beforeEach(() => {
    // Exactly what a browser hands you over plain http: no `credentials`.
    Reflect.deleteProperty(navigator, "credentials");
  });

  it("reports itself unavailable", () => {
    expect(passkeysAvailable()).toBe(false);
  });

  it("refuses registration by name rather than throwing a raw TypeError", async () => {
    const refusal = await refusalFrom(() =>
      createPasskey({ challenge_id: "cid", public_key: { challenge: b64([1]) } }),
    );

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(TypeError);
    expect((refusal as Error).message).toMatch(/secure \(HTTPS\) connection/);
  });

  it("refuses authentication by name rather than throwing a raw TypeError", async () => {
    const refusal = await refusalFrom(() =>
      getPasskey({
        challenge_id: "cid",
        public_key: { challenge: b64([1]), rp_id: "irc.example" },
      }),
    );

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(TypeError);
    expect((refusal as Error).message).toMatch(/secure \(HTTPS\) connection/);
  });
});

describe("passkeys — base64url ⇄ ArrayBuffer", () => {
  // Every sample exercises a different pad length (0/1/2 `=`) AND both
  // URL-alphabet substitutions, so a lost pad or a `-`/`+` mix-up moves
  // at least one of them.
  const SAMPLES = ["-_-_", "abc", "-A", "AQIDBAUGBwgJCg"];

  it.each(SAMPLES)("round-trips %s unchanged through decode → encode", async (sample) => {
    // The challenge goes IN as base64url, is decoded to an ArrayBuffer for
    // the authenticator, and comes back OUT re-encoded as `raw_id`. Echoing
    // the decoded buffer back as the credential makes the pair an identity
    // check using only production code — no local re-implementation of
    // either half to drift against.
    credentials.get.mockImplementation(async (options: unknown) => {
      const challenge = publicKeyOf<PublicKeyCredentialRequestOptions>(options)
        .challenge as ArrayBuffer;
      return {
        rawId: challenge,
        response: {
          authenticatorData: challenge,
          clientDataJSON: challenge,
          signature: challenge,
          userHandle: null,
        },
      };
    });

    const result = await getPasskey(requestOptions({ challenge: sample }));

    expect(result.raw_id).toBe(sample);
  });

  it("decodes the URL alphabet as `-`→`+` and `_`→`/`, not the reverse", async () => {
    // "-_-_" is "+/+/" in standard base64 → 0xFB 0xFF 0xBF. Swapping the
    // two substitutions yields a different byte triple, and dropping them
    // makes `atob` throw — either way this pin moves.
    credentials.get.mockResolvedValue({
      rawId: new Uint8Array([1]).buffer,
      response: {
        authenticatorData: new Uint8Array([2]).buffer,
        clientDataJSON: new Uint8Array([3]).buffer,
        signature: new Uint8Array([4]).buffer,
        userHandle: null,
      },
    });

    await getPasskey(requestOptions({ challenge: "-_-_" }));

    const publicKey = optionsGivenTo<PublicKeyCredentialRequestOptions>(credentials.get);
    expect(bytesOf(publicKey.challenge)).toEqual([0xfb, 0xff, 0xbf]);
  });

  it("strips the `=` padding off the encoded output", async () => {
    // A 1-byte buffer is 4 base64 chars, 2 of them padding. `=` is not
    // URL-safe and the server decodes strict base64url, so the pad MUST
    // be gone on the way out.
    credentials.get.mockResolvedValue({
      rawId: new Uint8Array([0xf8]).buffer,
      response: {
        authenticatorData: new Uint8Array([0xf8]).buffer,
        clientDataJSON: new Uint8Array([0xf8]).buffer,
        signature: new Uint8Array([0xf8]).buffer,
        userHandle: null,
      },
    });

    const result = await getPasskey(requestOptions({}));

    expect(result.raw_id).toBe("-A");
  });
});

describe("createPasskey", () => {
  it("reports itself available when the browser implements the ceremony", () => {
    expect(passkeysAvailable()).toBe(true);
  });

  const options = {
    challenge_id: "cid",
    public_key: {
      challenge: b64([1, 2, 3]),
      rp: { id: "irc.example", name: "Grappa" },
      user: { id: b64([4, 5]), name: "vjt", display_name: "vjt" },
      pub_key_cred_params: [{ type: "public-key", alg: -7 }],
      timeout: 300000,
      attestation: "none",
      authenticator_selection: { resident_key: "preferred", user_verification: "required" },
    },
  };

  it("hands the browser the camelCase shape with decoded buffers", async () => {
    await createPasskey(options);

    const publicKey = optionsGivenTo<PublicKeyCredentialCreationOptions>(credentials.create);
    expect(bytesOf(publicKey.challenge)).toEqual([1, 2, 3]);
    expect(bytesOf(publicKey.user.id)).toEqual([4, 5]);
    expect(publicKey.user.displayName).toBe("vjt");
    expect(publicKey.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }]);
    expect(publicKey.authenticatorSelection).toEqual({
      residentKey: "preferred",
      userVerification: "required",
    });
  });

  it("leaves no snake_case key behind for the browser to ignore", async () => {
    await createPasskey(options);

    const publicKey = optionsGivenTo<PublicKeyCredentialCreationOptions>(credentials.create);
    expect(Object.keys(publicKey).filter((key) => key.includes("_"))).toEqual([]);
  });
});

describe("getPasskey", () => {
  it("decodes allow_credentials so a non-discoverable key can be offered", async () => {
    await getPasskey({
      challenge_id: "cid",
      public_key: {
        challenge: b64([7]),
        rp_id: "irc.example",
        timeout: 300000,
        user_verification: "required",
        allow_credentials: [{ type: "public-key", id: b64([1, 2, 3]), transports: ["usb"] }],
      },
    });

    const publicKey = optionsGivenTo<PublicKeyCredentialRequestOptions>(credentials.get);
    expect(publicKey.rpId).toBe("irc.example");
    expect(publicKey.userVerification).toBe("required");

    const descriptor = definedOr(publicKey.allowCredentials?.[0], "one offered credential");
    expect(descriptor.type).toBe("public-key");
    expect(descriptor.transports).toEqual(["usb"]);
    expect(bytesOf(descriptor.id)).toEqual([1, 2, 3]);
  });

  it("omits transports when the server sent no hint", async () => {
    await getPasskey({
      challenge_id: "cid",
      public_key: {
        challenge: b64([7]),
        rp_id: "irc.example",
        allow_credentials: [{ type: "public-key", id: b64([1]) }],
      },
    });

    const publicKey = optionsGivenTo<PublicKeyCredentialRequestOptions>(credentials.get);
    const descriptor = definedOr(publicKey.allowCredentials?.[0], "one offered credential");
    expect("transports" in descriptor).toBe(false);
  });

  it("sends an empty allow list when the passwordless door offered none", async () => {
    await getPasskey({
      challenge_id: "cid",
      public_key: { challenge: b64([7]), rp_id: "irc.example", user_verification: "required" },
    });

    expect(
      optionsGivenTo<PublicKeyCredentialRequestOptions>(credentials.get).allowCredentials,
    ).toEqual([]);
  });
});

describe("passkeys — getPasskey (assertion ceremony)", () => {
  const assertion = {
    rawId: new Uint8Array([0x01]).buffer,
    response: {
      authenticatorData: new Uint8Array([0x02]).buffer,
      clientDataJSON: new Uint8Array([0x03]).buffer,
      signature: new Uint8Array([0x04]).buffer,
      userHandle: new Uint8Array([0x05]).buffer,
    },
  };

  it("rebuilds the wire options into the camelCase WebAuthn shape", async () => {
    credentials.get.mockResolvedValue(assertion);

    await getPasskey(
      requestOptions({
        timeout: 60_000,
        user_verification: "required",
        allow_credentials: [
          { type: "public-key", id: "AQID", transports: ["internal"] },
          { type: "public-key", id: "BAUG" },
        ],
      }),
    );

    const publicKey = optionsGivenTo<PublicKeyCredentialRequestOptions>(credentials.get);
    expect(publicKey.rpId).toBe("grappa.example");
    expect(publicKey.timeout).toBe(60_000);
    expect(publicKey.userVerification).toBe("required");
    const allowed = publicKey.allowCredentials ?? [];
    expect(allowed.map((item) => bytesOf(item.id))).toEqual([
      [0x01, 0x02, 0x03],
      [0x04, 0x05, 0x06],
    ]);
    // `transports` is OMITTED (not `undefined`) when the wire omits it —
    // Safari rejects a descriptor carrying an explicit undefined.
    expect(allowed[0]?.transports).toEqual(["internal"]);
    expect(allowed[1] === undefined ? true : "transports" in allowed[1]).toBe(false);
  });

  it("sends an empty allowCredentials when the wire omits it", async () => {
    credentials.get.mockResolvedValue(assertion);

    await getPasskey(requestOptions({}));

    expect(
      optionsGivenTo<PublicKeyCredentialRequestOptions>(credentials.get).allowCredentials,
    ).toEqual([]);
  });

  it("returns the assertion with the challenge_id it was handed", async () => {
    credentials.get.mockResolvedValue(assertion);

    const result = await getPasskey(requestOptions({}));

    expect(result).toEqual({
      challenge_id: "challenge-1",
      raw_id: "AQ",
      authenticator_data: "Ag",
      client_data_json: "Aw",
      signature: "BA",
      user_handle: "BQ",
    });
  });

  it("keeps a null user_handle null instead of encoding it", async () => {
    // A second-factor assertion carries no user handle. `encode(null)`
    // would throw inside `String.fromCharCode`, so the null MUST survive
    // as null all the way to the wire.
    credentials.get.mockResolvedValue({
      ...assertion,
      response: { ...assertion.response, userHandle: null },
    });

    const result = await getPasskey(requestOptions({}));

    expect(result.user_handle).toBeNull();
  });

  it("rejects with a cancelled message when the user dismisses the prompt", async () => {
    // Chrome resolves `get()` with null on some dismiss paths instead of
    // rejecting; without the guard the next line reads `.rawId` off null
    // and the user sees a TypeError.
    credentials.get.mockResolvedValue(null);

    await expect(getPasskey(requestOptions({}))).rejects.toThrow(
      "Passkey authentication cancelled",
    );
  });
});

describe("passkeys — createPasskey (registration ceremony)", () => {
  const attestation = {
    rawId: new Uint8Array([0x01]).buffer,
    response: {
      attestationObject: new Uint8Array([0x02]).buffer,
      clientDataJSON: new Uint8Array([0x03]).buffer,
      getTransports: () => ["usb", "nfc"],
    },
  };

  it("rebuilds the wire options into the camelCase WebAuthn shape", async () => {
    credentials.create.mockResolvedValue(attestation);

    await createPasskey(
      creationOptions({
        attestation: "none",
        authenticator_selection: { resident_key: "required", user_verification: "preferred" },
        exclude_credentials: [{ type: "public-key", id: "AQID" }],
      }),
    );

    const publicKey = optionsGivenTo<PublicKeyCredentialCreationOptions>(credentials.create);
    // `display_name` → `displayName` is the whole reason this rebuild
    // exists; a passthrough would hand the authenticator an undefined.
    expect(publicKey.user.displayName).toBe("Alice L");
    expect(publicKey.user.name).toBe("alice");
    expect(bytesOf(publicKey.user.id)).toEqual([0x75, 0x73, 0x65, 0x72]);
    expect(publicKey.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }]);
    expect(publicKey.attestation).toBe("none");
    expect(publicKey.authenticatorSelection).toEqual({
      residentKey: "required",
      userVerification: "preferred",
    });
    expect((publicKey.excludeCredentials ?? []).map((item) => bytesOf(item.id))).toEqual([
      [0x01, 0x02, 0x03],
    ]);
  });

  it("returns the attestation with the transports the authenticator reported", async () => {
    credentials.create.mockResolvedValue(attestation);

    const result = await createPasskey(creationOptions({}));

    expect(result).toEqual({
      challenge_id: "challenge-1",
      raw_id: "AQ",
      attestation_object: "Ag",
      client_data_json: "Aw",
      transports: ["usb", "nfc"],
    });
  });

  it("sends an empty transports list when the authenticator has no getTransports", async () => {
    // `getTransports` is not universal (older Safari/Firefox). The optional
    // call MUST degrade to [] rather than blow up the registration.
    credentials.create.mockResolvedValue({
      ...attestation,
      response: { ...attestation.response, getTransports: undefined },
    });

    const result = await createPasskey(creationOptions({}));

    expect(result.transports).toEqual([]);
  });

  it("rejects with a cancelled message when the user dismisses the prompt", async () => {
    credentials.create.mockResolvedValue(null);

    await expect(createPasskey(creationOptions({}))).rejects.toThrow("Passkey creation cancelled");
  });
});
