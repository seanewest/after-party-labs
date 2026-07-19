(() => {
  const productionRedirectUri = 'https://seanewest.github.io/after-party-labs/';
  const localRedirectUri = 'http://127.0.0.1:4173/';
  const redirectUri = globalThis.location?.origin === 'http://127.0.0.1:4173'
    ? localRedirectUri
    : productionRedirectUri;

  globalThis.afterPartyConfig = Object.freeze({
    authentication: Object.freeze({
      clientId: '9edaa951-658e-4be2-9623-ee906cb604b2',
      authority: 'https://login.microsoftonline.com/organizations',
      redirectUri,
    }),
    redirectUris: Object.freeze({
      production: productionRedirectUri,
      local: localRedirectUri,
    }),
    microsoftGraphDelegatedScopes: Object.freeze([
      'User.Read',
      'Directory.ReadWrite.All',
      'Application.ReadWrite.All',
      'Group.ReadWrite.All',
      'User.ReadWrite.All',
      'RoleManagement.ReadWrite.Directory',
      'Policy.ReadWrite.ConditionalAccess',
      'AuditLog.Read.All',
      'Reports.Read.All',
      'Mail.ReadWrite',
      'Mail.Send',
      'Files.ReadWrite.All',
      'Sites.ReadWrite.All',
      'SecurityEvents.ReadWrite.All',
    ]),
  });
})();
