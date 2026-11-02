// Overview tile for a treatment, shown in the Treatments grid and in search results.
import '../../../assets/css/style.css';
import '../../../assets/css/base.css';
import 'bootstrap/dist/css/bootstrap.css';
import defaultImage from '../../../assets/images/tile_images/treatment_default.jpg';
import { Link } from 'react-router-dom';
import React from 'react';

/**
 * Overview card for one treatment.
 * @param {{data: object, id: number|string, query?: string}} props `query` highlights matches.
 * @returns {JSX.Element} the card.
 */
export function TreatmentTile({ data, id, query }) {
  var image = defaultImage;
  if (data.media !== '') {
    image = data.media;
  }

  // Reusable function to highlight text
  const highlightText = (text) => {
    if (typeof text !== 'string') return text;

    if (!query) return text;

    const regex = new RegExp(`(${query})`, 'gi');
    return text.split(regex).map((part, index) =>
      part.match(regex) ? <mark key={index}>{part}</mark> : part
    );
  };
  
  // Helper function to bold the text before the colon
  const boldBeforeColon = (text) => {
    return <span style={{ fontWeight: 600 }}>{text}</span>;
  };

  return (
    <div class="card tile">
      <img src={image} style={{ width: '100%', height: 300, objectFit: 'cover' }} alt="" />
      <div class="card-body">
        <h5 class="card-title">{highlightText(data?.name)}</h5>
      </div>
      <ul class="overviewTile list-group list-group-flush">
        <li class="list-group-item">
        {boldBeforeColon("Description:")} {highlightText(data.description)}
        </li>
        <li class="list-group-item">
        {boldBeforeColon("Title:")}{' '}{highlightText(data?.title? data.title.toLowerCase().split(' ').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' '): '')}
        </li>
        <li class="list-group-item">
        {boldBeforeColon("URL:")}{' '}
          <a href={data.url} isExternal={true} target="_blank" class="card-link">
            {data.url}
          </a>
        </li>
        <li class="list-group-item">
        {boldBeforeColon("Treatment Type: ")}{highlightText(data.treatment_type)}
        </li>
      </ul>
      <div class="card-body">
        <Link to={'/treatments/' + id} class="btn btn-primary">
          More Info
        </Link>
      </div>
    </div>
  );
}
