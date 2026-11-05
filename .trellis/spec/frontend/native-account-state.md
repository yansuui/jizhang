# Native account ownership

Android `ApiRequestOwner` advances generation on session/server replacement;
`AuthRepository.sessionKey` also remounts the Compose shell. Authenticated storage
uses normalized server plus immutable user ID. `FinancialScope.storageIdentity`
passes that identity to financial preferences, pending operations and assistant
batch recovery. New `v2` namespaces never adopt old username-only pending writes;
keep those records and show a recovery notice. Switching to a same-named account
must not replay an unresolved write. Legacy-server login may omit ID, but invite
registration requires it. `clients/android/README.md` is the maintained inventory.

iOS owns each API session through a fresh UUID and replaces the complete feature
tree when activating another account; see `ios-client.md`. Public login/register
errors do not expire an unrelated saved account. Both clients gate invitation UI
on explicit server capabilities; the server remains the permission authority.

