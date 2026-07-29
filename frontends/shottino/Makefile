ROOT := ../..
-include $(ROOT)/config.mk

CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -Wpedantic -O2
CPPFLAGS ?= -D_POSIX_C_SOURCE=200809L
PREFIX ?= /usr/local
BINDIR ?= $(PREFIX)/bin
CFLAGS += $(CFLAGS_DEPS)
LDLIBS += $(LDLIBS_DEPS)

BIN := shottino
OBJS := shottino.o json.o wire.o alias.o mirc.o termcolor.o http.o media.o

# Test binaries link only the pure modules they exercise — no ncurses, no
# OpenSSL, no terminal. That is the point of keeping the narrowing and
# formatting code free of app state: it stays testable without a TTY.
# test_layout is the ONE exception: it compiles shottino.c itself and
# renders to an offscreen ncurses screen (newterm to /dev/null), because
# the chat area's clipping contract cannot be expressed in a leaf module.
#
# Tests build with ASan+UBSan: this is C, and the parser walks attacker-
# shaped input off the network. A leak or a one-past-the-end read in the
# arena is exactly the class of bug that passes a plain assertion suite and
# corrupts the app hours later. Override SANITIZE= to disable on a toolchain
# without the runtime.
#
# COVERAGE CAVEAT: the sanitizers ride these test binaries only, and the
# `all` binary is built WITHOUT them. shottino.c's own logic — websocket
# framing, event dispatch, app state — is covered only where test_layout
# reaches, which is the drawing primitives and nothing else. Do not trust
# this net for changes elsewhere in that file; add a test or reason about
# the path by hand.
TESTS := tests/test_json tests/test_wire tests/test_alias tests/test_mirc tests/test_termcolor tests/test_http tests/test_media tests/test_layout tests/test_keys
SANITIZE ?= -fsanitize=address,undefined -fno-omit-frame-pointer
TEST_CFLAGS := -std=c11 -Wall -Wextra -Wpedantic -O1 -g $(SANITIZE)

.PHONY: all install clean check

all: $(BIN)

$(BIN): $(OBJS)
	$(CC) $(CPPFLAGS) $(CFLAGS) -o $@ $(OBJS) $(LDLIBS)

%.o: %.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -c -o $@ $<

shottino.o: shottino.c json.h wire.h alias.h mirc.h termcolor.h http.h media.h
json.o: json.c json.h
wire.o: wire.c wire.h json.h
alias.o: alias.c alias.h
mirc.o: mirc.c mirc.h
termcolor.o: termcolor.c termcolor.h
http.o: http.c http.h
media.o: media.c media.h termcolor.h

tests/test_json: tests/test_json.c tests/test.h json.c json.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_json.c json.c

tests/test_wire: tests/test_wire.c tests/test.h wire.c wire.h json.c json.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_wire.c wire.c json.c

tests/test_alias: tests/test_alias.c tests/test.h alias.c alias.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_alias.c alias.c

tests/test_mirc: tests/test_mirc.c tests/test.h mirc.c mirc.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_mirc.c mirc.c

tests/test_termcolor: tests/test_termcolor.c tests/test.h termcolor.c termcolor.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_termcolor.c termcolor.c

tests/test_http: tests/test_http.c tests/test.h http.c http.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_http.c http.c

tests/test_media: tests/test_media.c tests/test.h media.c media.h termcolor.c termcolor.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_media.c media.c termcolor.c

# The only suite that needs the app's own build environment: it includes
# shottino.c, so it takes the same feature-test macros ($(CFLAGS_DEPS),
# which is what puts strcasestr and cfmakeraw in scope) and links what
# shottino links.
tests/test_layout: tests/test_layout.c tests/test.h shottino.c json.c wire.c alias.c mirc.c termcolor.c http.c media.c
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) $(CFLAGS_DEPS) -o $@ tests/test_layout.c json.c wire.c alias.c mirc.c termcolor.c http.c media.c $(LDLIBS)

# test_keys needs a pty (-lutil): it feeds real byte sequences through the
# client's own key decoding, because every key bug so far has been about
# what the terminal DELIVERS rather than what the handler does with it.
tests/test_keys: tests/test_keys.c tests/test.h shottino.c json.c wire.c alias.c mirc.c termcolor.c http.c media.c
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) $(CFLAGS_DEPS) -o $@ tests/test_keys.c json.c wire.c alias.c mirc.c termcolor.c http.c media.c $(LDLIBS) -lutil

# `make check` is the gate: build every suite, run every suite, fail loud.
check: $(TESTS)
	@rc=0; for t in $(TESTS); do \
		printf '== %s\n' "$$t"; \
		./$$t || rc=1; \
	done; exit $$rc

install: $(BIN)
	install -d "$(DESTDIR)$(BINDIR)"
	install -m 0755 "$(BIN)" "$(DESTDIR)$(BINDIR)/$(BIN)"

clean:
	rm -f $(BIN) $(OBJS) $(TESTS)
