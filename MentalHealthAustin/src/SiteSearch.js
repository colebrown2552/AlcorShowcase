// Site-wide search results page: fuse.js fuzzy search across all three models with highlighted snippets.
import React from 'react';
import { useParams } from 'react-router-dom';
import Fuse from 'fuse.js';

/**
 * Search all disorders, treatments and locations for the :q route parameter.
 * @param {{stateDisorderData: object[], stateTreatmentData: object[], stateLocationData: object[]}} props data from the API.
 * @returns {JSX.Element} grouped results.
 */
const SiteSearch = ({ title, stateDisorderData, stateTreatmentData, stateLocationData }) => {
  const { q } = useParams(); // Get the search query from the URL

  const options = {
    includeScore: false, // Remove relevance score
    threshold: 0.3, // Adjust the threshold as needed
  };

  const getAllKeysFromData = (data) => {
    const allKeys = new Set();
    data.forEach(item => {
      Object.keys(item).forEach(key => allKeys.add(key));
    });
    return Array.from(allKeys);
  };

  const performSearch = (data, keys, query) => {
    const fuse = new Fuse(data, { keys, ...options });
    const result = fuse.search(query.toLowerCase());

    // Sort by the presence of the query in a specific field
    result.sort((a, b) => {
      const queryIndexA = a.item[keys[0]].toLowerCase().indexOf(query.toLowerCase());
      const queryIndexB = b.item[keys[0]].toLowerCase().indexOf(query.toLowerCase());

      if (queryIndexA !== -1 && queryIndexB === -1) {
        return -1;
      } else if (queryIndexA === -1 && queryIndexB !== -1) {
        return 1;
      } else {
        return 0;
      }
    });

    return result.map((item) => item.item); // Return only the item, excluding the score
  };

  const sortItemsWithHighlight = (items, query) => {
    return items.sort((a, b) => {
      const aHasHighlight = hasHighlight(a, query);
      const bHasHighlight = hasHighlight(b, query);

      if (aHasHighlight && !bHasHighlight) {
        return -1;
      } else if (!aHasHighlight && bHasHighlight) {
        return 1;
      } else {
        return 0;
      }
    });
  };

  const hasHighlight = (item, query) => {
    const keys = Object.keys(item);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const value = item[key];

      if (typeof value === 'string') {
        const lowerCaseValue = value.toLowerCase();
        const lowerCaseQuery = query.toLowerCase();

        if (lowerCaseValue.includes(lowerCaseQuery)) {
          return true;
        }
      }
    }
    return false;
  };

  const allKeysDisorders = getAllKeysFromData(stateDisorderData);
  const allKeysTreatments = getAllKeysFromData(stateTreatmentData);
  const allKeysLocations = getAllKeysFromData(stateLocationData);

  const searchResultsDisorders = performSearch(stateDisorderData, allKeysDisorders, q);
  const searchResultsTreatments = performSearch(stateTreatmentData, allKeysTreatments, q);
  const searchResultsLocations = performSearch(stateLocationData, allKeysLocations, q);

  const extractWordsAroundMatch = (item, query) => {
  const keys = Object.keys(item);
  
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = item[key];

    if (typeof value === 'string') {
      const lowerCaseValue = value.toLowerCase();
      const queryWords = query.toLowerCase().split(' '); // Splitting query into words
      let highlightedText = value; // Initialize highlighted text

      for (let j = 0; j < queryWords.length; j++) {
        const lowerCaseQuery = queryWords[j];

        const matches = [];
        let match;
        const regex = new RegExp(lowerCaseQuery, 'gi');

        while ((match = regex.exec(lowerCaseValue)) !== null) {
          matches.push(match.index); // Store index of each match
        }

        // Highlight all matches for the current word in the query
        matches.forEach((matchIndex) => {
          const startIndex = Math.max(0, matchIndex - 15);
          const endIndex = Math.min(value.length, matchIndex + lowerCaseQuery.length + 15);

          highlightedText = highlightedText.substring(0, startIndex) +
            highlightedText.substring(startIndex, endIndex).replace(
              new RegExp(lowerCaseQuery, 'gi'),
              match => `<mark>${match}</mark>`
            ) +
            highlightedText.substring(endIndex);
        });
      }

      // Limit to 50 words
      const wordsWithEllipses = '...' + highlightedText.split(' ').slice(0, 60).join(' ') + '...';

      return { field: key, highlightedText: wordsWithEllipses };
    }
  }

  return { field: null, highlightedText: null };
};


const extractWordsAroundTitle = (item, query) => {
  const keys = Object.keys(item);
  let temp = { ...item }; // Create a shallow copy of the object

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = item[key];

    if (typeof value === 'string') {
      const queryWords = query.split(' '); // Splitting query into words

      let matches = [];

      queryWords.forEach(queryWord => {
        const regex = new RegExp(queryWord, 'gi');
        let match;
        while ((match = regex.exec(value)) !== null) {
          matches.push({ index: match.index, word: match[0] });
        }
      });

      matches.forEach(matchData => {
        const { word } = matchData;
        const highlightedWord = `<mark>${word}</mark>`;

        temp[key] = temp[key].replace(new RegExp(word, 'gi'), highlightedWord);
      });
    }
  }

  // Find the property containing modified text
  const modifiedTextProperty = Object.keys(temp).find(key => typeof temp[key] === 'string');

  return { highlightedTitle: modifiedTextProperty ? temp[modifiedTextProperty] : '' };
};

  const renderItems = (category, linkPath, searchResults) => (
    <div className={`pt-2 ${category.toLowerCase()}`}>
      <h2>{category}</h2>
      {sortItemsWithHighlight(searchResults, q).map((item, index) => {
        const { field, highlightedText } = extractWordsAroundMatch(item, q);
        const { highlightedTitle } = extractWordsAroundTitle({ name: item.name }, q);
        return (
          <div key={index} className="result">
            <a href={`/${linkPath}/${item.id}`}>
            {highlightedTitle ? (
              <span dangerouslySetInnerHTML={{ __html: highlightedTitle }} />
            ) : (
              <span>{item.name}</span>
            )}
            </a>
            {field && (
              <div>
                <strong>{field.charAt(0).toUpperCase() + field.slice(1)}:</strong>{' '}
                {highlightedText && (
                  <span dangerouslySetInnerHTML={{ __html: highlightedText }} />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="grid-container">
      <div className="grid-100 mobile-grid-100 tablet-grid-100 pb-5">
        <div className="text-align-center pt-5">
          <h1>{title}</h1>
        </div>

        {renderItems('Disorders', 'disorders', searchResultsDisorders)}
        {renderItems('Treatments', 'treatments', searchResultsTreatments)}
        {renderItems('Locations', 'locations', searchResultsLocations)}
      </div>
    </div>
  );
};

export default SiteSearch;
