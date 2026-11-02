// Overview tile for a disorder, shown in the Disorders grid and in search results.
// DisorderTile.js
import '../../../assets/css/style.css';
import '../../../assets/css/base.css';
import 'bootstrap/dist/css/bootstrap.css';
import defaultImage from '../../../assets/images/tile_images/disorder_default.jpg';
import { Link } from "react-router-dom";
import React from 'react';

/**
 * Overview card for one disorder.
 * @param {{data: object, id: number|string, query?: string}} props `query` highlights matches.
 * @returns {JSX.Element} the card.
 */
export function DisorderTile({ data, id, query }) {
  var image = defaultImage;
  if (data.image_url !== "") {
    image = data.image_url;
  }

  // Helper function to highlight the matching section of text
  const highlightText = (text) => {
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
      {data && <div>
        <div className="display-flex align-items-center">
          <img src={image} style={{ width: '100%', height: 300, objectFit: 'cover' }} alt="" />
        </div>
        <div className="card-body">
          <h5 className="card-title">{highlightText(data.name)}</h5>
        </div>
        <ul className="overviewTile list-group list-group-flush">
          <li className="list-group-item">{boldBeforeColon("Description:")} {highlightText(data.description)}</li>
          <li className="list-group-item">{boldBeforeColon("Causes:")} {highlightText(data.causes)}</li>
          <li className="list-group-item">{boldBeforeColon("Diagnosis:")} {highlightText(data.diagnosis)}</li>
          <li className="list-group-item">{boldBeforeColon("Symptoms:")} {highlightText(data.symptoms)}</li>
        </ul>
        <div className="card-body">
          <Link to={"/disorders/" + id} className="btn btn-primary">More Info</Link>
        </div>
      </div>}
    </div>
  );
}
