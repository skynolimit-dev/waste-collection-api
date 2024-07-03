const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const moment = require('moment');
const _ = require('lodash');


let resultsCache = {};

// Globals
const config = {
  bins: require('../config/bins.json'),
  urls: require('../config/urls.json')
}

// Get and set (i.e. cache) the bin details (JSON data) for the given bin ID
async function getBinDetails(id) {

  const cachedResult = _.get(resultsCache, id, null);
  // If the cached result timestamp is less than 60 minutes old, return the cached result
  if (cachedResult && cachedResult.data && moment().diff(moment(cachedResult.timestamp), 'minutes') < 60) {
    console.log(`Returning cached result for ${id}`);
    return cachedResult.data;
  }

  try {
    id = parseInt(id, 10);

    if (id >= 0) {
      console.log(`Getting bin details for ${id}`);
      const url = `${config.urls.bromley}/${id}`;
      const waitFor = 'document.querySelector("body").innerText.includes("Your collections")';
      const html = await getHtml(url, waitFor);
      const data = getBinDetailsFromHtml(id, html);
      // Cache the result, and return the data
      _.set(resultsCache, id, { data: data, timestamp: moment().format() });
      return data;
    } else {
      console.warn(`No bin ID provided`);
      return { error: 'No bin ID provided' };
    }
  }
  catch (error) {
    console.warn(`Error getting bin details for ${id}: ${error}`);
    return { error: 'Error getting bin details for bin ID', id, error };
  }

}

async function getNextCollections(id) {
  let binDetails = await getBinDetails(id);

  // Add the category name to the bin details
  for (const [category, bin] of Object.entries(binDetails)) {
    bin.category = category;
  }

  // Then, convert to an array sorted by next collection date
  binDetails = _.orderBy(binDetails, ['nextCollectionUTC'], ['asc']);

  let nextCollectionDateUtc = binDetails[0].nextCollectionUTC;
  let nextBinsForCollection = [];

  if (binDetails.length > 0) {
    for (const bin of binDetails) {
      if (bin.nextCollectionUTC === nextCollectionDateUtc)
        nextBinsForCollection.push(bin.category);
      else
        break;
    }
  }

  const isTomorrow = moment().add(1, 'days').isSame(moment(nextCollectionDateUtc), 'day');

  return {
    nextCollectionDateUtc: nextCollectionDateUtc,
    nextCollectionDate: moment(nextCollectionDateUtc).format('YYYY-MM-DD'),
    nextCollectionDateDay: moment(nextCollectionDateUtc).format('dddd'),
    nextCollectionDateFriendly: moment(nextCollectionDateUtc).format('dddd, MMMM Do'),
    isTomorrow: isTomorrow,
    bins: nextBinsForCollection
  };
}

async function getBinsForTomorrow(id) {
  const binDetails = await getBinDetails(id);
  let binsForTomorrow = [];
  for (const collectionCategory in binDetails) {
    if (moment(binDetails[collectionCategory].nextCollectionUTC).isSame(moment().add(1, 'days'), 'day')) {
      binsForTomorrow.push(collectionCategory);
    }
  }
  return binsForTomorrow;
}

// Gets HTML for the given URL after waiting for the given function
async function getHtml(url, waitFor) {

  let retryCount = 0;

  while (retryCount < 3) {

    console.log(`Getting URL - retry count ${retryCount}: ${url}`);

    let pageContent = null;
    let browser = null;

    try {
      browser = await puppeteer.launch(
        {
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
          args: [
            // Required for Docker version of Puppeteer
            '--no-sandbox',
            '--disable-setuid-sandbox',
            // This will write shared memory files into /tmp instead of /dev/shm,
            // because Docker’s default for /dev/shm is 64MB
            '--disable-dev-shm-usage'
          ],
        });

      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
      await page.waitForFunction(waitFor);
      pageContent = await page.content();
      console.log(`Got URL: ${url}`);
    } catch (err) {
      console.log(`Error while fetching ${url} - `, err);
      retryCount++;
    } finally {
      await browser.close();
    }
    return pageContent;
  }

}

// Returns JSON data for the bin collections from the given HTML
function getBinDetailsFromHtml(id, html) {

  console.log(`Getting bin details for ${id}`);

  let binDetails = {};
  let headings = [];
  let nextCollections = [];
  let lastCollections = [];

  try {
    const $ = cheerio.load(html);

    // Get the collection headings ("Food Waste", "Paper & Cardboard", etc)
    $('h3[class*="govuk-heading-m waste-service-name"]').each((index, heading) => {
      headings.push($(heading).text().trim());
    });

    // Get the next and last collection dates
    $('div[class*="govuk-summary-list__row"]').each((index, row) => {
      const rowLabel = $(row).find('dt[class*="govuk-summary-list__key"]').first().text().trim();
      if (rowLabel === 'Next collection')
        nextCollections.push($(row).find('dd[class*="govuk-summary-list__value"]').first().text().replace(/\s\s+/g, ' ').trim());
      else if (rowLabel === 'Last collection')
        lastCollections.push($(row).find('dd[class*="govuk-summary-list__value"]').first().text().replace(/\s\s+/g, ' ').trim());
    });

  } catch (error) {
    console.error(`Error parsing bin details for ${id}:`, error);
    return null;
  }

  for (let index = 0; index < headings.length; index++) {
    _.set(binDetails, `${headings[index]}.nextCollection`, nextCollections[index]);
    _.set(binDetails, `${headings[index]}.nextCollectionUTC`, moment(nextCollections[index], 'dddd, Do MMMM').toISOString());
    _.set(binDetails, `${headings[index]}.lastCollection`, lastCollections[index]);
    _.set(binDetails, `${headings[index]}.lastCollectionUTC`, moment(lastCollections[index], 'dddd, Do MMMM, at h:ma').toISOString());
  }

  // Sort the bin details by next collection date
  // binDetails = _.orderBy(binDetails, ['nextCollectionUTC'], ['asc']); 

  console.log(`Got bin details for ${id}: ${JSON.stringify(binDetails, 2)}`);

  return binDetails;

}



// Process the notification check for the given user
function processNotificationCheck(user) {
  console.log(`Processing notification check for ${user.id}`);
  const binDetails = _.get(userInfo, `${user.id}.binDetails.data`);

  const collectionsForTomorrow = [];
  let collectionDate = '';

  // For all the entries in the bin details, check if the next collection date is tomorrow
  // Ignore any categories in the user's ignore list
  for (const collectionCategory in binDetails) {

    if (user.ignore && user.ignore.includes(collectionCategory))
      console.log(`Ignoring ${collectionCategory} for ${user.id}`);
    else {
      let nextCollectionString = binDetails[collectionCategory].nextCollection;
      // If the next collection string includes a bracket, remove the extraneous information]
      // e.g. "Saturday, 20th April (this collection has been adjusted from its usual time)"
      // -> "Saturday, 20th April"
      if (nextCollectionString.includes('('))
        nextCollectionString = nextCollectionString.substring(0, nextCollectionString.indexOf('(')).trim();
      const nextCollectionDate = moment(nextCollectionString, 'dddd, Do MMMM');
      console.log('Next collection date: ', nextCollectionDate.format('YYYY-MM-DD'));
      // Check how many days the next collection date is from today
      console.log('Days until next collection: ', nextCollectionDate.diff(moment(), 'days'));

      // If the next collection date is tomorrow, add it to the list of collections for tomorrow
      if (nextCollectionDate.isSame(moment().add(1, 'days'), 'day')) {
        console.log(`Collection for ${collectionCategory} is tomorrow`);
        collectionsForTomorrow.push(collectionCategory);
        collectionDate = binDetails[collectionCategory].nextCollection;
      }
    }
  }

  // If there are collections scheduled for tomorrow, send a notification
  if (collectionsForTomorrow.length > 0) {
    console.log(`Collections for tomorrow (${collectionDate}): ${collectionsForTomorrow}`);
    sendNotification(user, collectionsForTomorrow, collectionDate);
  }
}

function getCache() {
    return resultsCache;
}


// Automatically get and cache selected bin IDs
function autoCacheBins() {
  console.log('Auto-caching bins');
  for (const binId of config.bins) {
    getBinDetails(binId);
  }

  // Schedule the next run
  setTimeout(autoCacheBins, 30 * 30 * 1000);
}


// Autocache the bins
autoCacheBins();


module.exports = {
  getBinDetails,
  getCache,
  getNextCollections,
  getBinsForTomorrow
};