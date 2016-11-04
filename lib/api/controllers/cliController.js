var
  ResponseObject = require('kuzzle-common-objects').Models.responseObject,
  BadRequestError = require('kuzzle-common-objects').Errors.badRequestError,
  NotFoundError = require('kuzzle-common-objects').Errors.notFoundError,
  Promise = require('bluebird');

/**
 * @param {Kuzzle} kuzzle
 * @constructor
 */
function CliController (kuzzle) {
  this.init = () => {
    this.actions = {
      adminExists: kuzzle.funnel.controllers.admin.adminExists,
      createFirstAdmin: kuzzle.funnel.controllers.admin.createFirstAdmin,
      cleanDb: require('./cli/cleanDb')(kuzzle),
      clearCache: require('./cli/clearCache')(kuzzle),
      managePlugins: require('./cli/managePlugins')(kuzzle),
      data: require('./cli/data')(kuzzle)
    };

    kuzzle.services.list.broker.listen(kuzzle.config.queues.cliQueue, this.onListenCB);
    kuzzle.pluginsManager.trigger('log:info', 'CLI controller initialized');
  };

  this.onListenCB = (request) => {
    var err;

    if (!request.action) {
      err = new BadRequestError('No action given.');

      kuzzle.services.list.broker.send(request.requestId, new ResponseObject(request, err));
      // error has been sent to the client. Do not need to throw here
      return Promise.resolve();
    }

    if (!this.actions[request.action]) {
      err = new NotFoundError('The action "' + request.action + '" does not exist.');

      kuzzle.services.list.broker.send(request.requestId, new ResponseObject(request, err));
      // error has been sent to the client. Do not need to throw here
      return Promise.resolve();
    }

    return this.actions[request.action](request)
      .then(response => kuzzle.services.list.broker.send(request.requestId, new ResponseObject(request, response)))
      .catch(error => kuzzle.services.list.broker.send(request.requestId, new ResponseObject(request, error)));
  };
}

module.exports = CliController;