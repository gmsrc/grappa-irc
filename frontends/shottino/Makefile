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
OBJS := shottino.o json.o wire.o alias.o

# Test binaries link only the pure modules they exercise — no ncurses, no
# OpenSSL, no terminal. That is the point of keeping the narrowing and
# formatting code free of app state: it stays testable without a TTY.
#
# Tests build with ASan+UBSan: this is C, and the parser walks attacker-
# shaped input off the network. A leak or a one-past-the-end read in the
# arena is exactly the class of bug that passes a plain assertion suite and
# corrupts the app hours later. Override SANITIZE= to disable on a toolchain
# without the runtime.
TESTS := tests/test_json tests/test_wire tests/test_alias
SANITIZE ?= -fsanitize=address,undefined -fno-omit-frame-pointer
TEST_CFLAGS := -std=c11 -Wall -Wextra -Wpedantic -O1 -g $(SANITIZE)

.PHONY: all install clean check

all: $(BIN)

$(BIN): $(OBJS)
	$(CC) $(CPPFLAGS) $(CFLAGS) -o $@ $(OBJS) $(LDLIBS)

%.o: %.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -c -o $@ $<

shottino.o: shottino.c json.h wire.h alias.h
json.o: json.c json.h
wire.o: wire.c wire.h json.h
alias.o: alias.c alias.h

tests/test_json: tests/test_json.c tests/test.h json.c json.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_json.c json.c

tests/test_wire: tests/test_wire.c tests/test.h wire.c wire.h json.c json.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_wire.c wire.c json.c

tests/test_alias: tests/test_alias.c tests/test.h alias.c alias.h
	$(CC) $(CPPFLAGS) $(TEST_CFLAGS) -o $@ tests/test_alias.c alias.c

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
