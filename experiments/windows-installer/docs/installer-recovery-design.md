# Installer recovery design under review

This is a design candidate, not a release procedure. The runtime update is
disabled because an interrupted write was shown to corrupt the original file.
The installer also refuses before creating the PAC profile or runtime. The
retry acceptance test remains unsatisfied. Do not deploy this candidate.

In isolated local Windows tests, an exclusive file handle prevented a competing
writer and blocked replacement and parent-directory rename. A process termination
between writing and truncating the file left mixed old and new contents. An
atomic `ReplaceFile` attempt while that exclusive handle was open failed with a
sharing violation. Allowing delete sharing permitted replacement while the
handle was open, and therefore did not exclude an independent replacement.
These observations do not prove behaviour on network filesystems.

A separate local NTFS experiment renamed the exclusively opened original file
to an unused name by its own handle without changing its bytes. A two-step
rename can nevertheless leave the expected runtime path absent after a crash.
An existing loader may treat an absent runtime as optional, so a durable,
trusted startup recovery mechanism would be required. The experiment is not a
reviewed implementation and does not establish NT API portability.
The prototype rejected a different backup with identical content and changed
content on the same file by comparing identity and digest while holding one
exclusive handle. A competing write failed while that handle remained open,
and the tested parent junction was refused. Recovery after termination at the
original-to-backup rename preserved the verified original and refused a target
collision. The prototype journal is only a test fixture; its authenticity and
durability, ancestor identity, file ID reuse protection, and power-loss safety
are not established.

A separate local NTFS test created a new hard link while the prototype held an
exclusive handle after verifying a single link. The resulting regression test
fails. Checking link count only before the rename cannot exclude this race;
the prototype therefore does not prove identity and namespace exclusivity.
A further synthetic test observed hard-link creation in a different directory
while the original parent directory was held open with no sharing. Holding the
parent directory alone therefore does not close this observed gap. The same
creation succeeded when both the file and its parent directory were held open
with no sharing in the tested local NTFS environment.

In one synthetic sequence, termination was injected during and after writing the
identity record, during staging, after staging was flushed, after moving the
original, and after moving the staged replacement. The verified original was
preserved in each case; after the original move it could be renamed back if the
target was vacant, including after a second termination before the recovery
rename. This does not exercise startup recovery, retry of an incomplete record,
concurrent recovery, or actual application integration.

The handle-path check rejects the tested existing parent junction and a junction
introduced immediately before opening the file. These are individual tests, not
a proof against every path race. The tested retry after dependency failure
currently refuses the retained profile; safe automatic retry is not implemented.

## Boundaries

The installer runs in the existing HAPI profile, preserves active sessions and
uses no PAC-specific HAPI source modifications. An existing `Runtime.ps1`, a
foreign PAC profile, and their contents are user data. Never delete or overwrite
them based only on a file name or an unverified marker.

The legacy `Install-ExistingProfile.ps1`, `Install-PacRunner.ps1`, and
`Install-FromRepo.ps1` entrypoints use or download a HAPI binary and runtime
pin, and perform separate runtime and profile writes. They are disabled in this
isolated candidate and must not be presented as compatible fallbacks.

## Candidate state model

1. Validate prerequisites and Git sources before creating any installation
   objects. Refuse a ZIP-only checkout before writing profile or runtime files.
2. Create an owner-protected, uniquely named staging directory. Record a schema
   version, operation identifier, source revision, expected original runtime
   digest, target profile identity, and completed phases. Never store tokens in
   the journal. Retain uncertain staging data for inspection.
3. Prepare immutable, versioned provider files and dependencies in staging.
   Verify every file before selecting the revision. Existing live versions are
   not modified.
4. Install a stable bootstrap once. It must select only a verified, immutable
   version through a separately controlled pointer. The first installation of
   that bootstrap into an existing runtime is an unresolved safety problem.
5. Select a fully prepared revision by updating the pointer. The implementation
   must prove crash atomicity, path identity, exclusion of independent writers,
   and rollback without losing an independently modified pointer. A database or
   other cooperating-writer mechanism alone does not prove safety against an
   independent process replacing the path.
6. On restart, examine the journal and actual file identities. Resume only a
   phase whose ownership and inputs are proven. Otherwise preserve the files and
   report the exact manual recovery requirement. Never infer ownership from the
   presence of a directory alone.

## Research option: move the locked original aside

The following sequence is a hypothesis for recovery, not a supported installer:

1. Prepare and flush the complete replacement and a protected write-ahead record
   containing the original file identity, expected digest, replacement digest,
   owner, target directory identity and reserved backup name.
2. Open the original with the necessary rename rights and exclusive sharing.
   Verify the opened file identity, its final path and digest, and the held parent
   directory identity. Rename that same opened file to an unused backup name
   without replacement. A collision or a changed identity must stop the operation.
3. Move the already prepared replacement into the now empty target name using a
   no-replace operation. If another process creates the name first, preserve both
   files and report the conflict. Never overwrite the new occupant.
4. On a later attempt, if the target name is absent, recover only the recorded
   original by its verified identity and digest under an exclusive handle, again
   using a no-replace operation. If the name is occupied or any identity differs,
   preserve all objects and refuse automatic recovery.

This creates an interval in which the target path is absent. A crash in that
interval leaves the original bytes in the backup, but the current startup path
can skip the absent runtime. A trusted recovery hook must therefore be available
before runtime loading. Installing and updating that hook itself, preventing a
new runner from observing the gap, validating the journal, holding all relevant
directory handles and proving no-replace behaviour remain unresolved. NT API
and filesystem compatibility must be tested; no production dependency on a
driver-level interface should be assumed from the local experiment.

## Open safety questions

- How can the first bootstrap be installed into an existing `Runtime.ps1`
  without a partial file after process or power failure, while excluding an
  independent writer or path replacement throughout the operation?
- How are every ancestor, the target file identity, reparse points and remote
  filesystem semantics validated without a check-to-use race?
- How is an incomplete operation distinguished from a pre-existing profile and
  from an operation concurrently started by another installer?
- How are a runtime, pointer and journal recovered when a crash occurs between
  any two state transitions, without deleting or overwriting unrelated data?
- How are the stable bootstrap, versioned files and journal protected against
  modification or replacement by a different Windows account?

## Recovery contract to establish

The intended transaction covers prerequisite validation, staging, journal
creation, installation or migration of the loader, selection of a version,
and recovery before any runner can observe an incomplete state. Disabling the
provider, changing a dispatcher, and configuring notifications need the same
ownership and no-clobber contract; they cannot be considered safe merely
because initial installation has passed.

For each step, a review must identify the durable inputs, exclusively owned
objects and the exact recovery action for a missing, partial, replaced or
independently modified object. When the installer cannot prove ownership and
identity, it must preserve the objects and refuse rather than overwrite or
remove them. A safe retry must distinguish an installer-created incomplete
operation from an existing foreign configuration without relying only on a
directory name, content digest, or writable marker.

The trust boundary must be explicit. An ACL restricting other Windows accounts
does not authenticate a record against an unrelated process running as the
same account. File IDs can be reused after deletion and an exclusive file
handle does not prevent the observed creation of a new hard link. A candidate
must address these cases, or explicitly constrain and validate its supported
environment instead of claiming protection against arbitrary independent
writers. No proposed bootstrap or journal in this worktree currently meets
that contract.

## Required evidence

- Actual clean-profile install and repeatable retry on both supported Windows
  machines, with existing HAPI identity and sessions preserved.
- Process termination at each file and journal transition, including during
  partial writes, flushing and replacement; reboot and power-loss guarantees must
  be tested separately where feasible.
- Competing writer, replacement, reparse-point and ancestor-swap tests before,
  during and after each operation; validate the final opened handle and content.
- Concurrent install, repeated retry, invalid or tampered journal, missing
  version, disk-full and permission-denied cases.
- Rollback tests proving exact preservation of pre-existing runtime bytes,
  unrelated files, active sessions, and profile ownership.
- Explicit coverage of supported filesystem and Windows versions; refuse
  unsupported environments rather than assuming local NTFS behaviour.

## Durability references

Microsoft documents that file data and metadata may be cached and discusses
flushing them in [File Caching](https://learn.microsoft.com/en-us/windows/win32/fileio/file-caching).
[CreateFile](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea)
describes write-through and notes storage hardware limitations. These sources
do not establish that this prototype's journal and both directory-entry
transitions survive power loss. The process-termination tests do not test a
system crash, storage cache, or power failure.

For path traversal research, Microsoft's general
[OBJECT_ATTRIBUTES](https://learn.microsoft.com/en-us/windows/win32/api/ntdef/ns-ntdef-_object_attributes)
documentation describes `OBJ_DONT_REPARSE`, while the user-mode
[NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)
page describes its accepted attribute values more narrowly. The exact supported
user-mode contract for the desired combination needs independent confirmation;
neither a flag name nor a local test is sufficient evidence for every Windows
version, filesystem or filter driver.
