targetScope = 'subscription'

@description('The tenant selected and verified by the signed-in operator.')
param expectedTenantId string

@description('The Azure subscription selected and verified by the signed-in operator.')
param expectedSubscriptionId string

@description('The public multitenant After Party application that may call the runtime API.')
param applicationClientId string

@description('The Azure region validated for every runtime resource type.')
param location string

@description('The resource group owned by this After Party runtime.')
@minLength(1)
@maxLength(90)
param resourceGroupName string

@description('A short lowercase name used for deterministic runtime resource names.')
@minLength(3)
@maxLength(30)
param runtimeName string

@minLength(40)
@maxLength(40)
@description('The exact source commit deployed by this runtime.')
param commit string

@description('A public API container image pinned to a sha256 digest.')
param apiImage string

var imageParts = split(apiImage, '@sha256:')
var inputShapeMatches = length(imageParts) == 2 && length(last(imageParts)) == 64 && length(applicationClientId) == 36
var targetMatches = subscription().subscriptionId == expectedSubscriptionId && tenant().tenantId == expectedTenantId && inputShapeMatches

resource runtimeResourceGroup 'Microsoft.Resources/resourceGroups@2024-11-01' = if (targetMatches) {
  name: resourceGroupName
  location: location
  tags: {
    'after-party-managed': 'true'
    'after-party-tenant-id': expectedTenantId
    'after-party-subscription-id': expectedSubscriptionId
    'after-party-commit': commit
  }
}

module runtime 'runtime.bicep' = if (targetMatches) {
  name: '${runtimeName}-runtime'
  scope: runtimeResourceGroup
  params: {
    expectedTenantId: expectedTenantId
    expectedSubscriptionId: expectedSubscriptionId
    applicationClientId: applicationClientId
    location: location
    runtimeName: runtimeName
    commit: commit
    apiImage: apiImage
  }
}

output tenantId string = expectedTenantId
output subscriptionId string = expectedSubscriptionId
output location string = location
output commit string = commit
output resourceGroupId string = targetMatches ? runtimeResourceGroup.id : ''
output apiId string = targetMatches ? runtime!.outputs.apiId : ''
output apiUrl string = targetMatches ? runtime!.outputs.apiUrl : ''
output authConfigId string = targetMatches ? runtime!.outputs.authConfigId : ''
output identityId string = targetMatches ? runtime!.outputs.identityId : ''
output stateContainerId string = targetMatches ? runtime!.outputs.stateContainerId : ''
output tenantLockBlobPath string = targetMatches ? runtime!.outputs.tenantLockBlobPath : ''
