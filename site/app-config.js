(() => {
  const productionRedirectUri = 'https://seanewest.github.io/after-party-labs/';
  const localRedirectUri = 'http://127.0.0.1:4173/';
  const redirectUri = globalThis.location?.origin === 'http://127.0.0.1:4173'
    ? localRedirectUri
    : productionRedirectUri;

  globalThis.afterPartyConfig = Object.freeze({
    applicationDisplayName: 'After Party',
    applicationHomeTenantId: '92563293-315c-4b6c-9b90-bcb47ee8c970',
    authentication: Object.freeze({
      clientId: '9edaa951-658e-4be2-9623-ee906cb604b2',
      authority: 'https://login.microsoftonline.com/organizations',
      redirectUri,
    }),
    redirectUris: Object.freeze({
      production: productionRedirectUri,
      local: localRedirectUri,
    }),
    runtimeApiScope: 'api://9edaa951-658e-4be2-9623-ee906cb604b2/AfterParty.Operate',
    runtime: Object.freeze({
      apiImage: '__AFTER_PARTY_RUNTIME_IMAGE__',
      commit: '__AFTER_PARTY_COMMIT__',
      templateUrl: new URL('runtime-template.json', redirectUri).href,
    }),
    azureResourceManagerScope: 'https://management.core.windows.net//user_impersonation',
    microsoftGraphDelegatedScopes: Object.freeze([
      'User.Read',
      'Directory.ReadWrite.All',
      'Application.ReadWrite.All',
      'AppRoleAssignment.ReadWrite.All',
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
