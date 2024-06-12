const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const moment = require('moment');
const _ = require('lodash');

const app = express();
app.use(cors());

// Globals
const config = {
  urls: require('./config/urls.json')
}

// Set the bin details (JSON data) for the given bin ID
async function getBinDetails(id) {

  console.log(`Getting bin details for ${id}`);

  const url=`${config.urls.bromley}/${id}`;
  const waitFor='document.querySelector("body").innerText.includes("Your collections")';
  const html = await getHtml(url, waitFor);
  return getBinDetailsFromHtml(id, html);

}

// Gets HTML for the given URL after waiting for the given function
async function getHtml(url, waitFor) {

  let retryCount = 0;

  while (retryCount < 3) {

    console.log(`Getting URL - retry count ${retryCount}: ${url}`);

    try {
      const browser = await puppeteer.launch(
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
      await page.goto(url, {waitUntil: 'networkidle0', timeout: 120000});
      await page.waitForFunction(waitFor);
      const pageContent = await page.content();
      await browser.close();
      console.log(`Got URL: ${url}`);
      return pageContent;
    } catch (err) {
      console.log(`Error while fetching ${url} - `, err);
      retryCount ++;
    } 
  }

}

// sleep time expects milliseconds
function sleep (time) {
  return new Promise((resolve) => setTimeout(resolve, time));
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

  for (let index = 0; index < headings.length; index ++) {
    _.set(binDetails, `${headings[index]}.nextCollection`, nextCollections[index]);
    _.set(binDetails, `${headings[index]}.lastCollection`, lastCollections[index]);
  }

  console.log(`Got bin details for ${id}: ${JSON.stringify(binDetails, 2)}`);

  return binDetails;

}


// Healthcheck endpoint
app.get('/healthcheck', (req, res) => {
  res.json({ status: 'ok' });
});

// API endpoint to get the bin details for a given bin ID
app.get('/api/v1/bin/:id', async (req, res) => {
  const id = req.params.id;
  const binDetails = await getBinDetails(id);
  res.json(binDetails);
});


// API endpoint to render a URL using Puppeteer
// The URL should be specified as a "url" query parameter
app.get('/api/v1/render', async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.send('please provide url');
  }
  try {
    const browser = await puppeteer.launch(
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
    await page.goto(url, {waitUntil: 'networkidle0'});
    await page.waitForFunction(
      'document.querySelector("body").innerText.includes("Your collections")'
    );
    const pageContent = await page.content();
    await browser.close();
    
    res.send(pageContent);
  } catch (err) {
    console.log(`Error while fetching ${url} `, err);
    res.send(`Error fetching ${url}`);
  }  
});

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


// Startup code

// Start the server
const PORT = process.env.PORT || 3004;
app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});