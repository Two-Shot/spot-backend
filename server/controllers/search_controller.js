const axios = require("axios");
const he = require("he");
let MusicItem = require("../models/music-item");

exports.getItems = async (req, res) => {
  const access_token = req.headers["authorization"];
  const params = req.query;
  console.log(access_token + " getting items");
  //Gets reddit API call results
  const redditData = await getRedditInfo(params);

  //Parses reddit results into useable data (array of objects)
  const parsedRedditData = parseRedditInfo(redditData.data, params.q);

  //Finds which reddit posts have already been stored in mongoDB
  let redditPostIDs = parsedRedditData.map((i) => i._id);
  const dbObjects = await MusicItem.find({
    _id: {
      $in: redditPostIDs,
    },
  });
  let dbDetails = [];
  let dbIDs = [];
  // IF items have been found in mongoDB, get the add the latest reddit info to objects
  if (dbObjects.length > 0) {
    dbDetails = dbObjects.map((i) => {
      return {
        ...i._doc,
        redditInfo: parsedRedditData.find((j) => j._id == i._doc._id)
          .redditInfo,
      };
    });
    // Store reddit post IDs fetched from DB in array
    dbIDs = dbDetails.map((i) => i._id);
    // Identify reddit posts from DB that have no spotify information against them to be ignored
    let noResults = dbDetails
      .filter((i) => i.spotInfoFound == false)
      .map((i) => i._id);
    // Remove items from reddit post id array that were found in DB but missing spotify info
    redditPostIDs = redditPostIDs.filter((i) => !noResults.includes(i));
  }
  // Store all items not found in mongoDB
  const apiItems = parsedRedditData.filter((i) => !dbIDs.includes(i._id));
  let apiDetails = [];
  // If items have not had info retrieved from DB, get info from spotify
  if (apiItems.length > 0) {
    // Get spotify info for missing items
    apiDetails = await getSpotDetails(apiItems, params.q, access_token);
    // Add spotify info (with spotInfo: true to mongoDB)
    await MusicItem.insertMany(apiDetails);
  }
  // combine db and new items and sort back to original order
  let allItems = [...dbDetails, ...apiDetails];
  allItems = redditPostIDs
    .map((id) => allItems.find((item) => item._id == id))
    .filter((i) => typeof i !== "undefined");

  //Removes duplicates from array
  allItems = Array.from(new Set(allItems.map((item) => item.spotInfo.url))).map(
    (url) => {
      return allItems.find((item) => item.spotInfo.url === url);
    }
  );
  res.json({
    results: allItems,
    after: redditData.after,
    before: redditData.before,
  });
};

const getRedditInfo = async (params) => {
  // Sets manual search string for Reddit API based on request
  let qString =
    params.q == "album"
      ? '?q=flair_name:"FRESH ALBUM" OR "FRESH ALBUM" OR "FRESH EP" OR "FRESH MIXTAPE"&'
      : '?q=flair_name:"FRESH" OR "FRESH" -flair_name:"FRESH ALBUM" -"FRESH ALBUM" -"FRESH EP" -"FRESH MIXTAPE" -"VIDEO"&';

  const constructURL = (params) => {
    console.log(params.subreddit);
    let url = "https://www.reddit.com/" + params.subreddit + "/search.json";
    const quantity = 50;
    const count =
      params.before !== "before"
        ? quantity * (params.page + 1)
        : params.page * quantity;
    url += qString + "sort=" + params.sort + "&" + "t=" + params.t + "&";
    url += "restrict_sr=" + "1" + "&limit=" + quantity + "&count=" + count;
    url += "&after=" + (params.after ? params.after : "after");
    url += "&before=" + (params.before ? params.before : "before");
    return url;
  };

  const fullResponse = await axios({
    url: constructURL(params),
    method: "get",
    mode: "cors",
  });
  const res = fullResponse.data;

  return {
    data: res.data.children,
    after: res.data.after,
    before: res.data.before,
  };
};

const parseRedditInfo = (list, requestType) => {
  //Creates array of two types of object eith useable data from reddit api results.
  //Filtered by reddit results that include a spotify link in title or description, and those that do not.
  const results = list.map((child) => {
    let baseObject = child.data.url.includes("open.spotify.com")
      ? {
          type: "spotify",
          spotInfo: {
            id: extractID(child.data.url),
            type: extractSpotType(child.data.url),
          },
        }
      : child.data.selftext.includes("open.spotify.com/")
      ? {
          type: "spotify",
          spotInfo: {
            id: extractID(child.data.selftext),
            type: extractSpotType(child.data.selftext),
          },
        }
      : {
          type: "text",
          spotInfo: null,
        };

    return {
      _id: child.data.id,
      requestType,
      redditInfo: {
        artist: extractArtist(he.decode(child.data.title)),
        album: extractAlbum(he.decode(child.data.title)),
        score: child.data.score,
        url: "https://www.reddit.com" + child.data.permalink,
      },
      ...baseObject,
    };
  });
  return results;
};

const getSpotDetails = async (data, requestType, access_token) => {
  //Splits reddit results objects into 3 arrays. Spotify album urls, spotify track urls and Text for manual search
  const [albumData, trackData, strSearchData] = [
    data.filter(
      (item) => item.type == "spotify" && item.spotInfo.type == "album"
    ),
    data.filter(
      (item) => item.type == "spotify" && item.spotInfo.type == "track"
    ),
    data.filter((item) => item.type == "text"),
  ];

  //Makes different Spotify API calls depending on data supplied
  //Then combines results back into single array
  let spotifyResults = [];
  spotifyResults =
    albumData.length > 0
      ? [
          ...spotifyResults,
          ...(await getSpotItems(
            albumData,
            "album",
            requestType,
            access_token
          )),
        ]
      : [...spotifyResults];
  spotifyResults =
    trackData.length > 0
      ? [
          ...spotifyResults,
          ...(await getSpotItems(
            trackData,
            "track",
            requestType,
            access_token
          )),
        ]
      : [...spotifyResults];
  spotifyResults =
    strSearchData.length > 0
      ? [
          ...spotifyResults,
          ...(await getSpotSearches(strSearchData, requestType, access_token)),
        ]
      : [...spotifyResults];

  // Store items that spotify could not be found for in DB so no repeat calls are made
  await MusicItem.insertMany(
    spotifyResults.filter((item) => !item.spotInfoFound)
  );

  // Filters out items with no spotify info and do not contain manually defined illegal terms
  spotifyResults = spotifyResults.filter(
    (item) => item.spotInfoFound && !isIllegalTerm(item)
  );

  return spotifyResults;
};

const getSpotItems = async (itemList, spotType, requestType, access_token) => {
  let results = [];
  //API allows reqeuests of 20 albums at once, and 50 tracks at once
  const chunkSize = requestType == "album" ? 20 : 50;

  for (let i = 0; i < itemList.length; i += chunkSize) {
    //splits itemList into smaller array to not exceed API rate limit
    const chunk = itemList.slice(i, i + chunkSize);

    //Constructs url with multiple id's
    let url = `https://api.spotify.com/v1/${spotType}s/?ids=`;
    chunk.forEach((item) => {
      url += item.spotInfo.id + ",";
    });
    url = url.slice(0, -1);

    const options = {
      url,
      method: "get",
      headers: {
        "Content-Type": "application/json",
        Authorization: access_token,
      },
    };

    const fullResponse = await axios(options);
    const res = fullResponse.data;
    //Loops through spotify API res and creates useable object depending on album or track.
    if (spotType == "album") {
      for (let c = 0; c < chunk.length; c += 1) {
        let itemID = "";
        //if searching for track, filters out full albums accidentally picked up
        if (requestType == "track" && res.albums[c].total_tracks > 2) {
          results.push({
            ...chunk[c],
            spotInfo: {},
            spotInfoFound: false,
          });
        } else
          try {
            // ALBUM TYPE WITH A SINGLE TRACK
            if (
              requestType == "track" &&
              res.albums[c].album_type == "single"
            ) {
              itemID = await getSpotSingleData(res.albums[c].id, options);
            } else if (
              requestType == "track" &&
              res.albums[c].total_tracks == 1
            ) {
              itemID = res.albums[c].tracks.items[0].id;
            }
            // ALBUM_TYPE SINGLE
            else {
              itemID = res.albums[c].id;
            }
            results.push({
              ...chunk[c],
              spotInfoFound: true,
              spotInfo: {
                name: res.albums[c].name,
                image: res.albums[c].images[0].url,
                released: res.albums[c].release_date,
                url: res.albums[c].external_urls.spotify,
                artist: {
                  name: res.albums[c].artists[0].name,
                  url: res.albums[c].artists[0].external_urls.spotify,
                },
                album: {
                  name: res.albums[c].name,
                  url: res.albums[c].external_urls.spotify,
                },
                id: itemID,
                type: extractSpotType(res.albums[c].external_urls.spotify),
              },
            });
          } catch (err) {
            console.log("missing details for:");
            console.table(chunk[c]);
          }
      }
    } else if (spotType == "track") {
      chunk.forEach(function (item, i) {
        if (res.tracks[i].type !== "album") {
          try {
            results.push({
              ...item,
              spotInfoFound: true,
              spotInfo: {
                name: res.tracks[i].name,
                image: res.tracks[i].album.images[0].url,
                url: res.tracks[i].external_urls.spotify,
                released: res.tracks[i].release_date,
                artist: {
                  name: res.tracks[i].artists[0].name,
                  url: res.tracks[i].artists[0].external_urls.spotify,
                },
                album: {
                  name: res.tracks[i].album.name,
                  url: res.tracks[i].album.external_urls.spotify,
                },
                id: res.tracks[i].id,
                type: extractSpotType(res.tracks[i].external_urls.spotify),
              },
            });
          } catch (err) {
            console.log("missing details for:");
            console.table(item);
          }
        }
      });
    }
  }
  return results;
};

const getSpotSearches = async (searchList, requestType, access_token) => {
  let spotResults = await Promise.all(
    searchList.map(async (item) => {
      //Searches spotify API using manually parsed artist & item terms extracted from reddit title for each item
      let url = `https://api.spotify.com/v1/search?q=${encodeURI(
        item.redditInfo.artist + " " + item.redditInfo.album
      )}&type=${item.requestType}`;

      let options = {
        url,
        method: "get",
        headers: {
          "Content-Type": "application/json",
          Authorization: access_token,
        },
      };
      const fullResponse = await axios(options);
      const res = fullResponse.data;
      //Spotify API may return multiple results per search. Basic match on reddit title terms to try and specify correct item from list.
      const selectedItem =
        item.requestType == "album"
          ? validateAlbum(
              res.albums.items,
              item.redditInfo.album,
              item.redditInfo.artist
            )
          : validateTrack(
              res.tracks.items,
              item.redditInfo.album,
              item.redditInfo.artist
            );
      if (selectedItem) {
        if (selectedItem.type == "album") {
          let itemID = "";
          if (requestType == "track" && selectedItem.album_type == "single") {
            itemID = await getSpotSingleData(selectedItem.id, options);
          } else if (requestType == "track" && selectedItem.total_tracks == 1) {
            itemID = selectedItem.tracks.items[0].id;
          } else {
            itemID = selectedItem.id;
          }
          return {
            ...item,
            spotInfo: {
              name: selectedItem.name,
              image: selectedItem.images[0].url,
              url: selectedItem.external_urls.spotify,
              released: selectedItem.release_date,
              artist: {
                name: selectedItem.artists[0].name,
                url: selectedItem.artists[0].external_urls.spotify,
              },
              album: {
                name: selectedItem.name,
                url: selectedItem.external_urls.spotify,
              },
              id: itemID,
              type: extractSpotType(selectedItem.external_urls.spotify),
            },
            spotInfoFound: true,
          };
        } else if (selectedItem.type == "track") {
          return {
            ...item,
            spotInfo: {
              name: selectedItem.name,
              image: selectedItem.album.images[0].url,
              url: selectedItem.external_urls.spotify,
              released: selectedItem.release_date,
              artist: {
                name: selectedItem.album.artists[0].name,
                url: selectedItem.album.artists[0].external_urls.spotify,
              },
              album: {
                name: selectedItem.album.name,
                url: selectedItem.album.external_urls.spotify,
              },
              id: selectedItem.id,
              type: extractSpotType(selectedItem.album.external_urls.spotify),
            },
            spotInfoFound: true,
          };
        }
      } else {
        return {
          ...item,
          spotInfo: {},
          spotInfoFound: false,
        };
      }
    })
  );
  return spotResults;
};

const getSpotSingleData = async (id, reqOptions) => {
  reqOptions.url = "https://api.spotify.com/v1/albums/" + id + "/tracks";
  let fullResponse = await axios(reqOptions);
  return fullResponse.data.items[0].id;
};

const extractID = (str) => {
  let splitStr = str.split(".spotify.com/")[1];

  let startIndex;
  try {
    startIndex = splitStr.indexOf("/") + 1;
  } catch (err) {
    console.log(err);
  }

  return splitStr.substring(startIndex, startIndex + 22);
};

const extractSpotType = (str) => {
  return str.split(".spotify.com/")[1].split("/")[0];
};

const extractArtist = (str) => {
  let reducedStr = str
    .replace(/\[[^()]*\]/g, "")
    .replace(/\([^()]*\)/g, "")
    .replace("and", " ")
    .replace("/", " ")
    .replace("\\", " ")
    .replace("#", " ")
    .replace("&", " ")
    .replace('"', " ")
    .replace(":", " ");
  reducedStr = reducedStr.split(" - ")[0];
  reducedStr = reducedStr.includes("ft.")
    ? reducedStr.split("ft.")[0]
    : reducedStr;
  reducedStr = reducedStr.trim();
  return reducedStr;
};

const extractAlbum = (str) => {
  let reducedStr = str
    .replace(/\[[^()]*\]/g, "")
    .replace(/\([^()]*\)/g, "")
    .replace("and", " ")
    .replace("ft.", " ")
    .replace("/", " ")
    .replace("\\", " ")
    .replace("#", " ")
    .replace("&", " ");

  return reducedStr.split(" - ")[1];
};

const validateAlbum = (albums, confirmation1, confirmation2) => {
  if (albums.length == 0) {
    return false;
  } else if (albums.length == 1) {
    return albums[0];
  } else {
    //loop through search results and see if any terms match to reddit title terms
    let found = false;
    let correctAlbum = {};
    albums.some((album) => {
      if (
        typeof confirmation1 !== "undefined" &&
        typeof confirmation2 !== "undefined" &&
        (album.name.toUpperCase() == confirmation1.trim().toUpperCase() ||
          album.name.toUpperCase() == confirmation2.trim().toUpperCase())
      ) {
        correctAlbum = album;
        found = true;
        return "exit loop";
      }
    });
    return found ? correctAlbum : albums[0];
  }
};

const validateTrack = (tracks) => {
  if (tracks.length == 0) {
    return false;
  }
  //ensures that a full album is not selected from spotify api results
  else if (tracks.length == 1 && tracks[0].album.album_type == "single") {
    return tracks[0].album;
  } else if (tracks[0].type == "track") {
    return tracks[0];
  } else {
    let found = false;
    let correctTrack = {};
    let counter = 0;
    tracks.some((track) => {
      if (track.album.album_type == "single" || track.type == "track") {
        correctTrack = track;
        found = true;
        return "exit loop";
      }
      //only checks first two results as further results are usually not relevant
      if (counter > 1) {
        found = false;
        return "exit loop";
      }
      counter += 1;
    });
    return found
      ? correctTrack
      : tracks[0].album.album_type == "single"
      ? tracks[0]
      : false;
  }
};

//filtering out manually identified issues with data parsing
const isIllegalTerm = (item) => {
  let name = item.spotInfo.name.toLowerCase();
  let type = item.requestType;
  if (
    name.includes("karaoke") ||
    name.includes("meditation") ||
    (name.includes("donda") && type == "track")
  ) {
    return true;
  }
  return false;
};
