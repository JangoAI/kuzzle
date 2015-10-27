var
  should = require('should'),
  winston = require('winston'),
  RequestObject = require.main.require('lib/api/core/models/requestObject'),
  params = require('rc')('kuzzle'),
  Kuzzle = require.main.require('lib/api/Kuzzle'),
  BadRequestError = require.main.require('lib/api/core/errors/badRequestError'),
  NotFoundError = require.main.require('lib/api/core/errors/notFoundError');

require('should-promised');

describe('Test: hotelClerk.countSubscription', function () {
  var
    kuzzle;

  before(function () {
    kuzzle = new Kuzzle();
    kuzzle.log = new (winston.Logger)({transports: [new (winston.transports.Console)({level: 'silent'})]});
    return kuzzle.start(params, {dummy: true});
  });

  it('should reject the request if no room ID has been provided', function () {
    var requestObject = new RequestObject({
      body: {}
    });

    return should(kuzzle.hotelClerk.countSubscription(requestObject)).be.rejectedWith(BadRequestError, { message: 'The room Id is mandatory for count subscription' });
  });

  it('should reject the request if the provided room ID is unknown to Kuzzle', function () {
    var requestObject = new RequestObject({
      body: { roomId: 'foobar' }
    });

    return should(kuzzle.hotelClerk.countSubscription(requestObject)).be.rejectedWith(NotFoundError, { message: 'The room Id foobar is unknown' });
  });

  it('should return the right subscriptions count when handling a correct request', function () {
    var
      subscribeRequest = new RequestObject({
          controller: 'subscribe',
          action: 'on',
          requestId: 'foo',
          collection: 'bar',
          body: { term: { foo: 'bar' } }
        }),
      countRequest = new RequestObject({ body: {}});

    return kuzzle.hotelClerk.addSubscription(subscribeRequest, { id: 'a connection'})
      .then(function (createdRoom) {
        countRequest.data.body.roomId = createdRoom.roomId;
        return kuzzle.hotelClerk.addSubscription(subscribeRequest, { id: 'another connection'});
      })
      .then(function () {
        return kuzzle.hotelClerk.countSubscription(countRequest);
      })
      .then(function (response) {
        should(response.roomId).be.exactly(countRequest.data.body.roomId);
        should(response.count).be.exactly(2);
        return kuzzle.hotelClerk.removeSubscription(subscribeRequest, { id: 'a connection'});
      })
      .then(function () {
        return kuzzle.hotelClerk.countSubscription(countRequest);
      })
      .then(function (response) {
        should(response.roomId).be.exactly(countRequest.data.body.roomId);
        should(response.count).be.exactly(1);
      });
  });
});
