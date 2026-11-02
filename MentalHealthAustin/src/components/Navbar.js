// Top navigation bar with links to every page and a site-wide search box.
import React, { useState } from 'react';
import logo from '../assets/images/header-logo.svg';
import { Link, useNavigate } from 'react-router-dom';

/**
 * Site navigation bar; submitting the search box routes to /search/:q.
 * @returns {JSX.Element} the navbar.
 */
const Navbar = ({ stateDisorderData, stateTreatmentData, stateLocationData }) => {
  const linkStyle = {
    textDecoration: 'none',
    color: '#010C80',
    fontWeight: 'bold',
    fontFamily: "'M PLUS 1p', sans-serif",
  };

  const linkHoverStyle = {
    color: '#77D4FC',
  };

  const [searchQuery, setSearchQuery] = useState('');
  const navigate = useNavigate();

  const handleSearch = () => {
    // Construct the URL for the search page and navigate to it
    navigate(`/search/${searchQuery}`);
  };

  return (
    <nav className="navbar navbar-expand-lg navbar-light bg-light">
      <div className="container d-flex justify-content-center align-items-center">
        <Link className="navbar-brand mr-4" to="/">
          <img src={logo} alt="Logo" width="100" />
        </Link>
        <button
          className="navbar-toggler"
          type="button"
          data-bs-toggle="collapse"
          data-bs-target="#navbarNav"
          aria-controls="navbarNav"
          aria-expanded="false"
          aria-label="Toggle navigation"
        >
          <span className="navbar-toggler-icon"></span>
        </button>
        <div className="collapse navbar-collapse" id="navbarNav">
          <ul className="navbar-nav ml-auto">
            <li className="nav-item">
              <Link
                className="nav-link"
                to="/"
                style={linkStyle}
                activeStyle={linkHoverStyle}
              >
                Home
              </Link>
            </li>
            <li className="nav-item">
              <Link
                className="nav-link"
                to="/about"
                style={linkStyle}
                activeStyle={linkHoverStyle}
              >
                About
              </Link>
            </li>
            <li className="nav-item">
              <Link
                className="nav-link"
                to="/disorders"
                style={linkStyle}
                activeStyle={linkHoverStyle}
              >
                Disorders
              </Link>
            </li>
            <li className="nav-item">
              <Link
                className="nav-link"
                to="/treatments"
                style={linkStyle}
                activeStyle={linkHoverStyle}
              >
                Treatments
              </Link>
            </li>
            <li className="nav-item">
              <Link
                className="nav-link"
                to="/locations"
                style={linkStyle}
                activeStyle={linkHoverStyle}
              >
                Locations
              </Link>
            </li>
            <li className="nav-item">
              <Link
                className="nav-link"
                to="/visuals"
                style={linkStyle}
                activeStyle={linkHoverStyle}
              >
                Visuals
              </Link>
            </li>
            <li className="nav-item searchbar">
              <div className="input-group">
                <input
                  type="text"
                  className="form-control"
                  placeholder="Search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <button
                  className="btn btn-outline-secondary"
                  type="button"
                  onClick={handleSearch}
                >
                  Search
                </button>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
