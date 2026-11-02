// Landing page with the site pitch and links to the three models.
import './assets/css/style.css';
import './assets/css/base.css';
import React from 'react';
import { Link } from 'react-router-dom';

/**
 * Renders the home page.
 * @returns {JSX.Element} the page.
 */
export function Landing() {
  return (
    <div>
      <section className="home display-flex">
        <div className="grid-container display-flex flex-column">
          <div className="grid-100 mobile-grid-100 tablet-grid-100 bubble text-align-center">
            <h1>
              Your Guide to Austin's Mental Health Landscape
            </h1>
          </div>
          <div className="mt-3 bubble">
            <Link to="/disorders" className="btn btn-primary rounded-pill"> Disorders </Link>
            <Link to="/treatments" className="btn btn-primary rounded-pill ms-3"> Treatments </Link>
            <Link to="/locations" className="btn btn-primary rounded-pill ms-3"> Locations </Link>
            <Link to="/visuals" className="btn btn-primary rounded-pill ms-3"> Visualizations </Link>
          </div>
        </div>
      </section>
    </div>
  );
}