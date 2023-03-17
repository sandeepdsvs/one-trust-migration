const fs = require('fs/promises');
const path = require('path');
const set = require('lodash/set');
const get = require('lodash/get');

// Set the directory containing the JSON files
const DEST_CONFIGS_PATH = '../rudder-integrations-config/src/configurations/destinations/';
const DEST_TESTS_PATH = '../rudder-integrations-config/test/data/validation/destinations/';
const DRY_RUN = true;

const logger = (message) => {
  console.log(message);
  console.log('\n');
}

const isOneTrustPresentInArray = (arrayToCheck) => {
  return arrayToCheck.find(field => field === 'oneTrustCookieCategories');
}

const updateConfig = async (dest, configFileName, updatedConfig) => {
  if (!DRY_RUN) {
    const promise = fs.writeFile(path.join(DEST_CONFIGS_PATH, dest, configFileName), JSON.stringify(updatedConfig));
    await promise;
  }
}

const updatedOneTrust = (oneTrustCookieCategories) => {
  const updatedOneTrustCookieCategories = [];

  Object.keys(oneTrustCookieCategories).forEach(sourceType => {
    updatedOneTrustCookieCategories.push(...oneTrustCookieCategories[sourceType]);
  });

  return updatedOneTrustCookieCategories;
}

const updateDbConfig = async (dest) => {
  try {
    const dbConfigString = await fs.readFile(path.join(DEST_CONFIGS_PATH, dest, 'db-config.json'), 'utf-8');
    const dbConfig = JSON.parse(dbConfigString);

    const destConfig = get(dbConfig, 'config.destConfig');

    if (isOneTrustPresentInArray(destConfig['defaultConfig'])) {
      return {status: 'not_updated', note: 'defaultConfig already contains oneTrustCookieCategories'};
    }

    Object.keys(destConfig).forEach(sourceType => {
      if (sourceType === 'defaultConfig') return;

      if (isOneTrustPresentInArray(destConfig[sourceType])) {
        // remove oneTrustCookieCategories from destConfig.{{sourceType}}
        destConfig[sourceType] = destConfig[sourceType].filter(field => !(field === 'oneTrustCookieCategories'));
      }
    });

    // insert into defaultConfig
    destConfig['defaultConfig'].push('oneTrustCookieCategories');
    set(dbConfig, 'config.destConfig', destConfig);

    // insert into includeKeys
    const includeKeys = get(dbConfig, 'config.includeKeys') || [];
    if (!isOneTrustPresentInArray(includeKeys)) {
      includeKeys.push('oneTrustCookieCategories');
      set(dbConfig, 'config.includeKeys', includeKeys);
    }

    await updateConfig(dest, 'db-config.json', dbConfig);
    return {status: 'updated'};
  } catch (e) {
    return {status: 'error', note: e}
  }
}

const updateUiConfig = async (dest) => {
  try {
    const uiConfigString = await fs.readFile(path.join(DEST_CONFIGS_PATH, dest, 'ui-config.json'), 'utf-8');
    const uiConfig = JSON.parse(uiConfigString);

    if (!Array.isArray(uiConfig['uiConfig'])) {
      return {status: 'not_updated', note: 'uiConfig is not an array'};
    }

    if (uiConfig['uiConfig'].find(group => group.title === 'Consent Settings')) {
      return {status: 'not_updated', note: 'uiConfig already contains Consent Settings'};
    }

    uiConfig['uiConfig'].push({
      title: 'Consent Settings', fields: [{
        type: 'dynamicCustomForm',
        value: 'oneTrustCookieCategories',
        label: 'OneTrust Cookie Categories',
        customFields: [{
          type: 'textInput',
          placeholder: 'Marketing',
          value: 'oneTrustCookieCategory',
          label: 'Category Name/ID',
          required: false
        }]
      }]
    });

    await updateConfig(dest, 'ui-config.json', uiConfig);
    return {status: 'updated'};
  } catch (e) {
    return {status: 'error', note: e}
  }
}

const updateSchema = async (dest) => {
  try {
    const schemaString = await fs.readFile(path.join(DEST_CONFIGS_PATH, dest, 'schema.json'), 'utf-8');
    const schema = JSON.parse(schemaString);

    if (!schema['configSchema'] || !schema['configSchema']['properties']) {
      return {status: 'not_updated', note: 'invalid schema'};
    }

    if (
      schema['configSchema']['properties']['oneTrustCookieCategories'] &&
      schema['configSchema']['properties']['oneTrustCookieCategories']['type'] === 'array'
    ) {
      return {status: 'not_updated', note: 'schema already updated'};
    }

    schema['configSchema']['properties']['oneTrustCookieCategories'] = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          oneTrustCookieCategory: {
            type: 'string',
            pattern: '(^\\{\\{.*\\|\\|(.*)\\}\\}$)|(^env[.].+)|^(.{0,100})$'
          }
        }
      }
    };

    await updateConfig(dest, 'schema.json', schema);
    return {status: 'updated'};
  } catch (e) {
    return {status: 'error', note: e}
  }
}

const updateTestFile = async (dest) => {
  try {
    const testString = await fs.readFile(path.join(DEST_TESTS_PATH, `${dest}.json`), 'utf-8');
    const tests = JSON.parse(testString);
    let isUpdated = false;

    tests.forEach(test => {
      if (test['config']['oneTrustCookieCategories']) {
        test['config']['oneTrustCookieCategories'] = updatedOneTrust(test['config']['oneTrustCookieCategories']);
        isUpdated = true;
      }
    });

    if (isUpdated) {
      if (!DRY_RUN) {
        const promise = fs.writeFile(path.join(DEST_TESTS_PATH, `${dest}.json`), JSON.stringify(tests));
        await promise;
      }
      return {status: 'updated'};
    } else {
      return {status: 'not_updated', note: 'oneTrustCookieCategories not found in tests'};
    }
  } catch (e) {
    return {status: 'error', note: e}
  }
}

const updateDestination = async (dest) => {
  const dbConfigStatus = await updateDbConfig(dest);
  const uiConfigStatus = await updateUiConfig(dest);
  const schemaStatus = await updateSchema(dest);
  let testStatus = {status: 'not_updated', note: 'schema not updated'};
  if (schemaStatus.status === 'updated') {
    testStatus = await updateTestFile(dest);
  }

  let destStatus = {destination: dest, dbConfigStatus, uiConfigStatus, schemaStatus, testStatus}
  if (
    dbConfigStatus.status === 'updated' &&
    uiConfigStatus.status === 'updated' &&
    schemaStatus.status === 'updated'
  ) {
    destStatus = {...destStatus, status: 'updated_all'};
  } else if (
    dbConfigStatus.status === 'not_updated' &&
    uiConfigStatus.status === 'not_updated' &&
    schemaStatus.status === 'not_updated'
  ) {
    destStatus = {...destStatus, status: 'updated_none'};
  } else {
    destStatus = {...destStatus, status: 'updated_partially'};
  }

  logger(destStatus);
  return destStatus;
};

const updateDestinations = async () => {
  let destinations = await fs.readdir(path.resolve(__dirname, DEST_CONFIGS_PATH));
  destinations.filter(dest => dest !== '.DS_Store');

  const promise = Promise.all(destinations.map(async dest => {
    return updateDestination(dest);
  }));

  return [await promise, destinations.length];
};

updateDestinations().then(([finalStatus, total]) => {
  const updated_none_count = finalStatus.filter(destStatus => destStatus.status === 'updated_none').length;
  const updated_all_count = finalStatus.filter(destStatus => destStatus.status === 'updated_all').length;
  const updated_partially_count = finalStatus.filter(destStatus => destStatus.status === 'updated_partially').length;

  const updated_partially_not_updated_reasons = {};
  const updateFailureMap = (configStatus) => {
    if (configStatus.status === 'not_updated') {
      if (updated_partially_not_updated_reasons[configStatus.note]) {
        updated_partially_not_updated_reasons[configStatus.note]++;
      } else {
        updated_partially_not_updated_reasons[configStatus.note] = 1;
      }
    }
  }

  finalStatus.filter(destStatus => destStatus.status === 'updated_partially')
    .forEach(destStatus => {
      updateFailureMap(destStatus.uiConfigStatus);
      updateFailureMap(destStatus.dbConfigStatus);
      updateFailureMap(destStatus.schemaStatus);
    });

  logger({updated_all_count, updated_none_count, updated_partially_count, total});
  logger({updated_partially_not_updated_reasons});
  logger({noOfTestFilesUpdated: finalStatus.filter(destStatus => destStatus.testStatus.status === 'updated').length});
});
