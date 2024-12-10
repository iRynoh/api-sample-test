# API Sample Test

## Getting Started

This project requires a newer version of Node. Don't forget to install the NPM packages afterwards.

You should change the name of the ```.env.example``` file to ```.env```.

Run ```node app.js``` to get things started. Hopefully the project should start without any errors.

## Explanations

The actual task will be explained separately.

This is a very simple project that pulls data from HubSpot's CRM API. It pulls and processes company and contact data from HubSpot but does not insert it into the database.

In HubSpot, contacts can be part of companies. HubSpot calls this relationship an association. That is, a contact has an association with a company. We make a separate call when processing contacts to fetch this association data.

The Domain model is a record signifying a HockeyStack customer. You shouldn't worry about the actual implementation of it. The only important property is the ```hubspot```object in ```integrations```. This is how we know which HubSpot instance to connect to.

The implementation of the server and the ```server.js``` is not important for this project.

Every data source in this project was created for test purposes. If any request takes more than 5 seconds to execute, there is something wrong with the implementation.

## Improvements

#### Code Quality and Readability:

- Split functionality into dedicated modules (as we did with processMeetings.js)
- Implement proper logging with levels (error, info, debug) instead of console.log, winston maybe?
- Add unit tests for each module with mock responses. Also a "live" one in case the API changes.
- Nice to have: TypeScript for better type safety and documentation

#### Project Architecture:

- Create a proper service layer to separate business logic from data access.
- Implement a queue system with fail retry.
- Add configuration management for different environments, good for testing and local dev.
- Create an abstraction layer for HubSpot API to isolate external dependencies. Like a repository? Maybe we offer another service like HubSpot, we would only need to change implementation instead of interfaces.

### Performance:

- Add caching layer for frequently accessed data. IMPORTANT.
- Implement rate limiting to prevent API throttling, configurable via the queue.
- Add parallel processing for independent operations.
- Monitor and optimize database queries.
- Add proper indexing for MongoDB collections.