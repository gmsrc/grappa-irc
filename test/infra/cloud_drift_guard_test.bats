#!/usr/bin/env bats
#
# Bats suite for infra/cloud/check-drift.sh — the #665 shared-ground guard.
#
# The guard proves both provider doors (infra/aws/*.yaml today, infra/terraform/
# *.tf later) reference the shared first-boot.sh AND expose the same knob names
# from infra/cloud/params.contract. These tests prove it goes GREEN on a
# faithful door and RED the moment a door drifts (a knob marker or the bootstrap
# reference goes missing) — the whole point of a guard is that it fails on drift.
#
# The REAL params.contract is copied into a sandbox REPO_ROOT (production knob
# list, not a re-typed one), and synthetic door files are written to exercise
# each drift shape.

setup() {
    REPO_SRC="$BATS_TEST_DIRNAME/../.."
    GUARD="$REPO_SRC/infra/cloud/check-drift.sh"

    export GRAPPA_REPO_ROOT="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$GRAPPA_REPO_ROOT/infra/cloud" "$GRAPPA_REPO_ROOT/infra/aws"
    # Use the real contract so the knob set under test is production truth.
    cp "$REPO_SRC/infra/cloud/params.contract" "$GRAPPA_REPO_ROOT/infra/cloud/params.contract"

    AWS_DOOR="$GRAPPA_REPO_ROOT/infra/aws/grappa.yaml"
}

# A faithful door: references first-boot.sh + carries every knob marker.
write_good_aws_door() {
    cat > "$AWS_DOOR" <<'EOF'
# grappa-knob: domain
# grappa-knob: admin_email
# grappa-knob: instance_type
# grappa-knob: ssh_cidr
# grappa-knob: disk_size_gb
UserData: curl .../infra/cloud/first-boot.sh | bash
EOF
}

@test "GREEN: a faithful AWS door passes" {
    write_good_aws_door
    run "$GUARD"
    [ "$status" -eq 0 ]
    [[ "$output" == *"expose all"* ]]
}

@test "RED: a missing knob marker fails with exit 1" {
    write_good_aws_door
    # Drop the ssh_cidr marker.
    grep -v "grappa-knob: ssh_cidr" "$AWS_DOOR" > "$AWS_DOOR.tmp"
    mv "$AWS_DOOR.tmp" "$AWS_DOOR"
    run "$GUARD"
    [ "$status" -eq 1 ]
    [[ "$output" == *"grappa-knob: ssh_cidr"* ]]
}

@test "RED: a door that does not reference first-boot.sh fails with exit 1" {
    write_good_aws_door
    grep -v "first-boot.sh" "$AWS_DOOR" > "$AWS_DOOR.tmp"
    mv "$AWS_DOOR.tmp" "$AWS_DOOR"
    run "$GUARD"
    [ "$status" -eq 1 ]
    [[ "$output" == *"first-boot.sh"* ]]
}

@test "tolerant: absent infra/terraform is NOT drift" {
    write_good_aws_door
    # No infra/terraform/ dir exists in the sandbox.
    run "$GUARD"
    [ "$status" -eq 0 ]
}

@test "GREEN: a faithful Terraform door is also checked once present" {
    write_good_aws_door
    mkdir -p "$GRAPPA_REPO_ROOT/infra/terraform"
    cat > "$GRAPPA_REPO_ROOT/infra/terraform/main.tf" <<'EOF'
# grappa-knob: domain
# grappa-knob: admin_email
# grappa-knob: instance_type
# grappa-knob: ssh_cidr
# grappa-knob: disk_size_gb
# user_data runs infra/cloud/first-boot.sh
EOF
    run "$GUARD"
    [ "$status" -eq 0 ]
}

@test "RED: a Terraform door missing a knob fails once present" {
    write_good_aws_door
    mkdir -p "$GRAPPA_REPO_ROOT/infra/terraform"
    cat > "$GRAPPA_REPO_ROOT/infra/terraform/main.tf" <<'EOF'
# grappa-knob: domain
# grappa-knob: admin_email
# grappa-knob: instance_type
# grappa-knob: ssh_cidr
# user_data runs infra/cloud/first-boot.sh
EOF
    run "$GUARD"
    [ "$status" -eq 1 ]
    [[ "$output" == *"disk_size_gb"* ]]
}

@test "no doors at all is not a failure (exit 0)" {
    # No infra/aws door written.
    run "$GUARD"
    [ "$status" -eq 0 ]
    [[ "$output" == *"no provider doors"* ]]
}

@test "missing contract fails with exit 2 (misuse)" {
    write_good_aws_door
    rm "$GRAPPA_REPO_ROOT/infra/cloud/params.contract"
    run "$GUARD"
    [ "$status" -eq 2 ]
}

@test "the REAL repo passes its own guard" {
    unset GRAPPA_REPO_ROOT
    run "$GUARD"
    [ "$status" -eq 0 ]
}
