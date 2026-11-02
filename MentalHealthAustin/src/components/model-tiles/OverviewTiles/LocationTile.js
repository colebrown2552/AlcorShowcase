// Overview tile for a treatment location, shown in the Locations grid and in search results.
import React from 'react';
import { Link } from 'react-router-dom';
import { FaStar } from 'react-icons/fa';
import { LocationMap } from '../../LocationMap.js';
import 'bootstrap/dist/css/bootstrap.css';

import '../../../assets/css/style.css';
import '../../../assets/css/base.css';

/**
 * Overview card for one location: OpenStreetMap preview, contact details and a link to its page.
 * @param {{data: object, id: number|string, query?: string}} props `query` highlights matches.
 */
export function LocationTile({ data, id, query }) {
  const highlightText = (text) => {
    if (typeof text !== 'string') return text;
  
    if (!query) return text;
  
    const regex = new RegExp(`(${query})`, 'gi');
    return text.split(regex).map((part, index) => part.match(regex) ? <mark key={index}>{part}</mark> : part);
  };

  // Helper function to bold the text before the colon
  const boldBeforeColon = (text) => {
    return <span style={{ fontWeight: 600 }}>{text}</span>;
  };

  return (
    <div className="card tile">
      <div className="display-flex align-items-center">
        <div style={{ width: '100%' }}>
          <LocationMap latitude={data.latitude} longitude={data.longitude} height={300} zoom={13} />
        </div>
      </div>
      <div className="card-body">
        <h5 className="card-title">{highlightText(data.name)}</h5>
      </div>
      <ul className="overviewTile list-group list-group-flush">
        <li className="list-group-item">{boldBeforeColon("Phone Number:")} {highlightText(data.phone_number)}</li>
        <li className="list-group-item">{boldBeforeColon("Address:")} {highlightText(data.address)}</li>
        <li className="list-group-item">{boldBeforeColon("Hours:")} {highlightText(data.hours)}</li>
        <li className="list-group-item">{boldBeforeColon("Latitude:")} {highlightText(data.latitude)}</li>
        <li className="list-group-item">{boldBeforeColon("Longitude:")} {highlightText(data.longitude)}</li>
      </ul>
      <div className="card-body">
        <Link to={`/locations/${id}`} className="btn btn-primary">More Info</Link>
      </div>
    </div>
  );
}
