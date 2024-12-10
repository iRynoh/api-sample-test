/**
 * @fileoverview Handles fetching and processing of HubSpot meetings, including attendee details
 * and creation/update status tracking. Integrates with the main worker pipeline to generate
 * meeting-related actions for contact analytics.
 * @module processMeetings
 * @requires '../utils'
 */

const {generateLastModifiedDateFilter, filterNullValuesFromObject} = require('../utils');

/**
 * Fetches meetings from HubSpot API with retry logic
 * @async
 * @param {Object} searchObject - Search parameters for HubSpot API
 * @param {Object} hubspotClient - HubSpot API client instance
 * @param {Date} expirationDate - Token expiration date
 * @param {Function} refreshAccessToken - Token refresh callback
 * @param {Object} domain - Domain configuration object
 * @param {string} hubId - HubSpot account ID
 * @returns {Promise<Object>} Parsed JSON response from HubSpot
 * @throws {Error} When retry attempts are exhausted
 */
const fetchMeetingsWithRetry = async (searchObject, hubspotClient, expirationDate, refreshAccessToken, domain, hubId) => {
    let tryCount = 0;
    while (tryCount <= 4) {
        try {
            const result = await hubspotClient.apiRequest({
                method: 'post',
                path: '/crm/v3/objects/meetings/search',
                body: searchObject
            });
            return await result.json();
        } catch (err) {
            tryCount++;
            if (new Date() > expirationDate) await refreshAccessToken(domain, hubId);
            await new Promise((resolve) => setTimeout(resolve, 5000 * Math.pow(2, tryCount)));
        }
    }
    throw new Error('Failed to fetch meetings after 4 retries');
};

/**
 * Retrieves contact associations for a batch of meetings
 * @async
 * @param {Array<Object>} meetings - Array of meeting objects
 * @param {Object} hubspotClient - HubSpot API client instance
 * @returns {Promise<Array>} Meeting-contact associations
 */
const getContactAssociations = async (meetings, hubspotClient) => {
    const meetingsToAssociate = meetings.map(meeting => meeting.id);
    const result = await hubspotClient.apiRequest({
        method: 'post',
        path: '/crm/v3/associations/MEETINGS/CONTACTS/batch/read',
        body: {inputs: meetingsToAssociate.map(meetingId => ({id: meetingId}))}
    });
    return (await result.json())?.results || [];
};

/**
 * Fetches detailed contact information for meeting attendees
 * @async
 * @param {Array<string>} contactIds - Array of contact IDs
 * @param {Object} hubspotClient - HubSpot API client instance
 * @returns {Promise<Array>} Contact details including profile and engagement data
 */
const getContactDetails = async (contactIds, hubspotClient) => {
    const result = await hubspotClient.crm.contacts.batchApi.read({
        inputs: contactIds.map(id => ({id})),
        properties: [
            'firstname',
            'lastname',
            'jobtitle',
            'email',
            'hubspotscore',
            'hs_lead_status',
            'hs_analytics_source',
            'hs_latest_source'
        ]
    });
    return result.results || [];
};

/**
 * Creates an action object for a meeting with all attendee information
 * @param {Object} meeting - Meeting data from HubSpot
 * @param {Array<Object>} contacts - Array of contact objects
 * @param {Date} lastPulledDate - Timestamp of last data pull
 * @returns {Object} Formatted action object for processing
 */
const createMeetingAction = (meeting, contacts, lastPulledDate) => {
    let attendees = contacts.map(contact => ({
        email: contact.properties.email,
        name: `${contact.properties.firstname || ''} ${contact.properties.lastname || ''}`.trim(),
        title: contact.properties.jobtitle,
        status: contact.properties.hs_lead_status,
        score: parseInt(contact.properties.hubspotscore) || 0
    }));
    const meetingProperties = {
        meeting_title: meeting.properties.hs_meeting_title,
        meeting_start: meeting.properties.hs_meeting_start_time,
        meeting_end: meeting.properties.hs_meeting_end_time,
        meeting_outcome: meeting.properties.hs_meeting_outcome,
        attendees: attendees
    };

    const isCreated = new Date(meeting.properties.hs_createdate) > lastPulledDate;

    return {
        actionName: isCreated ? 'Meeting Created' : 'Meeting Updated',
        actionDate: new Date(isCreated ? meeting.createdAt : meeting.updatedAt),
        includeInAnalytics: 0,
        meetingProperties: filterNullValuesFromObject(meetingProperties)
    };
};

/**
 * Main processing function for HubSpot meetings
 * @async
 * @param {Object} domain - Domain configuration object
 * @param {string} hubId - HubSpot account ID
 * @param {Object} q - Queue instance for action processing
 * @param {Object} hubspotClient - HubSpot API client instance
 * @param {Date} expirationDate - Token expiration date
 * @param {Function} refreshAccessToken - Token refresh callback
 * @returns {Promise<boolean>} Processing success status
 */
const processMeetings = async (domain, hubId, q, hubspotClient, expirationDate, refreshAccessToken) => {
    const account = domain.integrations.hubspot.accounts.find(account => account.hubId === hubId);
    const lastPulledDate = new Date(account.lastPulledDates.meetings);
    const now = new Date();

    let hasMore = true;
    const offsetObject = {};
    const limit = 100;

    while (hasMore) {
        const lastModifiedDate = offsetObject.lastModifiedDate || lastPulledDate;
        const searchObject = {
            filterGroups: [
                generateLastModifiedDateFilter(lastModifiedDate, now),
                {filters: [{propertyName: 'hs_meeting_outcome', operator: 'HAS_PROPERTY'}]}
            ],
            sorts: [{propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING'}],
            properties: ['hs_meeting_title', 'hs_meeting_body', 'hs_meeting_start_time',
                'hs_meeting_end_time', 'hs_meeting_outcome', 'hs_createdate'],
            limit,
            after: offsetObject.after
        };

        const searchResult = await fetchMeetingsWithRetry(searchObject, hubspotClient,
            expirationDate, refreshAccessToken, domain, hubId);
        const meetings = searchResult.results || [];

        const contactAssociations = await getContactAssociations(meetings, hubspotClient);
        for (const meeting of meetings) {
            const meetingAssociation = contactAssociations.find(a => a.from?.id === meeting.id);
            if (!meetingAssociation?.to?.length) continue;

            const contactIds = meetingAssociation.to.map(t => t.id);
            const contacts = await getContactDetails(contactIds, hubspotClient);

            if (contacts.length > 0) {
                const action = createMeetingAction(meeting, contacts, lastPulledDate);
                q.push(action);
            }
        }

        offsetObject.after = parseInt(searchResult.paging?.next?.after);
        if (!offsetObject?.after) {
            hasMore = false;
        } else if (offsetObject?.after >= 9900) {
            offsetObject.after = 0;
            offsetObject.lastModifiedDate = new Date(meetings[meetings.length - 1].updatedAt).valueOf();
        }
    }

    account.lastPulledDates.meetings = now;
    await saveDomain(domain);
    return true;
};

module.exports = processMeetings;