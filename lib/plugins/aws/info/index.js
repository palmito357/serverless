'use strict';

const BbPromise = require('bluebird');
const validate = require('../lib/validate');
const chalk = require('chalk');
const _ = require('lodash');

class AwsInfo {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.provider = this.serverless.getProvider('aws');
    this.options = options || {};
    Object.assign(this, validate);

    this.hooks = {
      'info:info': () => BbPromise.bind(this)
        .then(this.validate)
        .then(this.gather)
        .then(this.display),

      'deploy:deploy': () => BbPromise.bind(this)
        .then(() => {
          if (this.options.noDeploy) {
            return BbPromise.resolve();
          }
          return BbPromise.bind(this)
            .then(this.validate)
            .then(this.gather)
            .then(this.display);
        }),
    };
  }

  /**
   * Gather information about the service
   */
  gather() {
    const stackName = this.provider.naming.getStackName(this.options.stage);
    const info = {
      service: this.serverless.service.service,
      stage: this.options.stage,
      region: this.options.region,
    };

    // Get info from CloudFormation Outputs
    return this.provider.request('CloudFormation',
      'describeStacks',
      { StackName: stackName },
      this.options.stage,
      this.options.region)
    .then((result) => {
      let outputs;

      if (result) {
        outputs = result.Stacks[0].Outputs;

        const lambdaArnOutputRegex = this.provider.naming
          .getLambdaOutputLogicalIdRegex();

        const serviceEndpointOutputRegex = this.provider.naming
          .getServiceEndpointRegex();

        // Functions
        info.functions = [];
        outputs.filter(x => x.OutputKey.match(lambdaArnOutputRegex))
          .forEach(x => {
            const functionInfo = {};
            functionInfo.arn = x.OutputValue;
            functionInfo.name = functionInfo.arn.substring(x.OutputValue.lastIndexOf(':') + 1);
            info.functions.push(functionInfo);
          });

        // Endpoints
        outputs.filter(x => x.OutputKey.match(serviceEndpointOutputRegex))
          .forEach(x => {
            info.endpoint = x.OutputValue;
          });

        // Resources
        info.resources = [];

        // API Keys
        info.apiKeys = [];
      }

      // create a gatheredData object which can be passed around ("[call] by reference")
      const gatheredData = {
        outputs,
        info,
      };

      return BbPromise.resolve(gatheredData);
    })
    .then((gatheredData) => this.getApiKeyValues(gatheredData))
    .then((gatheredData) => BbPromise.resolve(gatheredData))
    .catch((e) => {
      let result;

      if (e.code === 'ValidationError') {
        // stack doesn't exist, provide only the general info
        const data = { info, outputs: [] };
        result = BbPromise.resolve(data);
      } else {
        // other aws sdk errors
        result = BbPromise.reject(new this.serverless.classes
          .Error(e.message));
      }

      return result;
    });
  }

  getApiKeyValues(gatheredData) {
    const info = gatheredData.info;

    // check if the user has set api keys
    const apiKeyNames = this.serverless.service.provider.apiKeys || [];

    if (apiKeyNames.length) {
      return this.provider.request('APIGateway',
        'getApiKeys',
        { includeValues: true },
        this.options.stage,
        this.options.region
      ).then((allApiKeys) => {
        const items = allApiKeys.items;
        if (items) {
          // filter out the API keys only created for this stack
          const filteredItems = items.filter((item) => _.includes(apiKeyNames, item.name));

          // iterate over all apiKeys and push the API key info and update the info object
          filteredItems.forEach((item) => {
            const apiKeyInfo = {};
            apiKeyInfo.name = item.name;
            apiKeyInfo.value = item.value;
            info.apiKeys.push(apiKeyInfo);
          });
        }
        return BbPromise.resolve(gatheredData);
      });
    }
    return BbPromise.resolve(gatheredData);
  }

  /**
   * Display service information
   */
  display(gatheredData) {
    const info = gatheredData.info;

    let message = '';

    message += `${chalk.yellow.underline('Service Information')}\n`;
    message += `${chalk.yellow('service:')} ${info.service}\n`;
    message += `${chalk.yellow('stage:')} ${info.stage}\n`;
    message += `${chalk.yellow('region:')} ${info.region}`;

    // Display API Keys
    let apiKeysMessage = `\n${chalk.yellow('api keys:')}`;

    if (info.apiKeys && info.apiKeys.length > 0) {
      info.apiKeys.forEach((apiKeyInfo) => {
        apiKeysMessage += `\n  ${apiKeyInfo.name}: ${apiKeyInfo.value}`;
      });
    } else {
      apiKeysMessage += '\n  None';
    }

    message += `${apiKeysMessage}`;

    // Display Endpoints
    let endpointsMessage = `\n${chalk.yellow('endpoints:')}`;

    if (info.endpoint) {
      _.forEach(this.serverless.service.functions, (functionObject) => {
        functionObject.events.forEach(event => {
          if (event.http) {
            let method;
            let path;

            if (typeof event.http === 'object') {
              method = event.http.method.toUpperCase();
              path = event.http.path;
            } else if (typeof event.http === 'string') {
              method = event.http.split(' ')[0].toUpperCase();
              path = event.http.split(' ')[1];
            }
            path = path !== '/' ? `/${path.split('/').filter(p => p !== '').join('/')}` : '';
            endpointsMessage += `\n  ${method} - ${info.endpoint}${path}`;
          }
        });
      });
    } else {
      endpointsMessage += '\n  None';
    }

    message += endpointsMessage;

    // Display Functions
    let functionsMessage = `\n${chalk.yellow('functions:')}`;

    if (info.functions && info.functions.length > 0) {
      info.functions.forEach((f) => {
        functionsMessage += `\n  ${f.name}: ${f.arn}`;
      });
    } else {
      functionsMessage += '\n  None';
    }

    message += `${functionsMessage}\n`;

    // when verbose info is requested, add the stack outputs to the output
    if (this.options.verbose) {
      message += `${chalk.yellow.underline('\nStack Outputs\n')}`;
      _.forEach(gatheredData.outputs, (output) => {
        message += `${chalk.yellow(output.OutputKey)}: ${output.OutputValue}\n`;
      });
    }

    this.serverless.cli.consoleLog(message);
    return message;
  }
}

module.exports = AwsInfo;
