targetScope = 'resourceGroup'

param expectedTenantId string
param expectedSubscriptionId string
param location string
param runtimeName string
param commit string
param apiImage string

var tags = {
  'after-party-managed': 'true'
  'after-party-tenant-id': expectedTenantId
  'after-party-subscription-id': expectedSubscriptionId
  'after-party-commit': commit
}
var identityName = '${runtimeName}-identity'
var environmentName = '${runtimeName}-environment'
var apiName = '${runtimeName}-api'
var storageName = take('ap${uniqueString(subscription().id, toLower(resourceGroup().id), runtimeName)}', 24)
var storageBlobDataContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: union(tags, { 'after-party-component': 'runtime-identity' })
}

resource stateStorage 'Microsoft.Storage/storageAccounts@2025-01-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  tags: union(tags, { 'after-party-component': 'state' })
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-01-01' = {
  parent: stateStorage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource stateContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' = {
  parent: blobService
  name: 'state'
  properties: {
    publicAccess: 'None'
  }
}

resource stateAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(stateContainer.id, runtimeIdentity.id, storageBlobDataContributorRoleId)
  scope: stateContainer
  properties: {
    description: 'After Party runtime access to its tenant-owned state container.'
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataContributorRoleId
  }
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: environmentName
  location: location
  tags: union(tags, { 'after-party-component': 'container-environment' })
  properties: {
    appLogsConfiguration: {
      destination: 'none'
    }
  }
}

resource api 'Microsoft.App/containerApps@2025-01-01' = {
  name: apiName
  location: location
  tags: union(tags, { 'after-party-component': 'api' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runtimeIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        allowInsecure: false
        external: true
        targetPort: 3000
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
        transport: 'http'
      }
    }
    template: {
      containers: [
        {
          name: 'api'
          image: apiImage
          env: [
            { name: 'AFTER_PARTY_TENANT_ID', value: expectedTenantId }
            { name: 'AFTER_PARTY_SUBSCRIPTION_ID', value: expectedSubscriptionId }
            { name: 'AFTER_PARTY_COMMIT', value: commit }
            { name: 'AFTER_PARTY_STATE_ACCOUNT', value: stateStorage.name }
            { name: 'AFTER_PARTY_STATE_CONTAINER', value: stateContainer.name }
            { name: 'AFTER_PARTY_TENANT_LOCK_BLOB', value: 'locks/tenant-operation.json' }
            { name: 'AZURE_CLIENT_ID', value: runtimeIdentity.properties.clientId }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
      }
    }
  }
}

output apiId string = api.id
output apiUrl string = 'https://${api.properties.configuration.ingress.fqdn}'
output identityId string = runtimeIdentity.id
output stateContainerId string = stateContainer.id
output tenantLockBlobPath string = 'locks/tenant-operation.json'
