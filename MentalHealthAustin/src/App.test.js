// Jest tests for the main pages and tiles (run with `npx jest`).
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { BrowserRouter } from 'react-router-dom';
import { Landing } from './Landing';
import { About } from './About.js'
import { Router } from 'react-router-dom';
import Navbar from './components/Navbar';
import { Route, Routes } from 'react-router-dom';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom'
import { LocationInfoTile } from './components/model-tiles/InfoTiles/LocationInfoTile.js';
import { DisorderInfoTile } from './components/model-tiles/InfoTiles/DisorderInfoTile.js';
import { TreatmentInfoTile } from './components/model-tiles/InfoTiles/TreatmentInfoTile.js';
import { LocationTile } from './components/model-tiles/OverviewTiles/LocationTile.js';
jest.mock('./assets/images/tile_images/location_default.jpg', () => 'path/to/mock-image2.jpg')
import { DisorderTile } from './components/model-tiles/OverviewTiles/DisorderTile.js';
jest.mock('./assets/images/tile_images/disorder_default.jpg', () => 'path/to/mock-image1.jpg')
import { TreatmentTile } from './components/model-tiles/OverviewTiles/TreatmentTile.js';
jest.mock('./assets/images/tile_images/treatment_default.jpg', () => 'path/to/mock-image3.jpg')
import { useParams, Link } from 'react-router-dom';
import GitLabStats from './components/about/GitLab.js';

test('Renders Landing Page', () => {
  render(
    <BrowserRouter>
      <Landing />
    </BrowserRouter>
  );
  const linkElement = screen.getByText(/Your Guide to Austin's Mental Health Landscape/i);
  expect(linkElement).toBeInTheDocument();
});


test('Renders Navbar with <nav> element', () => {
  render(
    <BrowserRouter>
      <Navbar />
    </BrowserRouter>
  );
  const navElement = screen.getByRole('navigation');
  // Check if the <nav> element is found
  expect(navElement).toBeInTheDocument();
});

test('Makes sure navbar has links to all 5 pages', () => {
  render(
    <BrowserRouter>
      <Navbar />
    </BrowserRouter>
  );
  const navElement = screen.getByRole('navigation');
  // Check if the <nav> element is found
  expect(navElement).toHaveTextContent("About");
  expect(navElement).toHaveTextContent("Home");
  expect(navElement).toHaveTextContent("Disorders");
  expect(navElement).toHaveTextContent("Treatments");
  expect(navElement).toHaveTextContent("Locations");
});

test('Renders About Page', () => {
  render(
    <BrowserRouter>
      <About />
    </BrowserRouter>
  );
  const linkElement = screen.getByText(/About Mental Health Austin/i);
  expect(linkElement).toBeInTheDocument();

});


test('Renders Disorder Tile', () => {
  const data = { name: 'Example Disorder', description: 'Description of the disorder' };
  render(
    <BrowserRouter>
      <DisorderTile data={data} id={0}></DisorderTile>
    </BrowserRouter>
  );
  const nameElement = screen.getByText(/Example Disorder/i);
  expect(nameElement).toBeInTheDocument();

});

test('Renders Location Tile', () => {
  const data = { name: 'Example Location', address: 'Location Address', rating: 1};
  render(
    <BrowserRouter>
      <LocationTile data={data} id={0}></LocationTile>
    </BrowserRouter>
  );
  const nameElement = screen.getByText(/Location Address/i);
  expect(nameElement).toBeInTheDocument();

});

test('Renders Treatment Tile', () => {
  const data = { name: 'Example Treatment', description: 'Sample Description'};
  render(
    <BrowserRouter>
      <TreatmentTile data={data} id={0}></TreatmentTile>
    </BrowserRouter>
  );
  const nameElement = screen.getByText(/Sample Description/i);
  expect(nameElement).toBeInTheDocument();

});


test('Renders DisorderInfo Tile', () => {
  const data = [
    {
      name: 'Example Disorder',
      description: 'Description of the disorder',
      image_url: '/path/to/image.jpg',
      causes: 'Causes of the disorder',
      diagnosis: 'Diagnosis of the disorder',
      symptoms: 'Symptoms of the disorder',
      link: 'https://example.com',
      treatments_list: [],
      locations_list: [],
    },
  ];
  render(
    <BrowserRouter>
      <DisorderInfoTile disorderData={data}></DisorderInfoTile>
    </BrowserRouter>
  );
  const nameElement = screen.getByText(/Example Disorder/i);
  expect(nameElement).toBeInTheDocument();

});

test('Renders TreatmentInfo Tile', () => {
  const data = [
    {
      name: 'Example Treatment',
      title: 'Example Title',
      disorders_list: [],
      locations_list: [],
    },
  ];
  render(
    <BrowserRouter>
      <TreatmentInfoTile treatmentData={data}></TreatmentInfoTile>
    </BrowserRouter>
  );
  const nameElement = screen.getByText(/Example Treatment/i);
  expect(nameElement).toBeInTheDocument();

});

test('Renders LocationInfo Tile', () => {
  const data = [
    {
      name: 'Example Location',
      rating: 1,
      disorders_list: [],
      treatments_list: [],
      rating: 1,
      hide_map: 1
    },
  ];
  render(
    <BrowserRouter>
      <LocationInfoTile locationData={data}></LocationInfoTile>
    </BrowserRouter>
  );
  const nameElement = screen.getByText(/Example Location/i);
  expect(nameElement).toBeInTheDocument();

});

// search testing
test('Testing Search Bar rendering', () => {
  render(
    <BrowserRouter>
      <Navbar />
    </BrowserRouter>
  );
  const nameElement = screen.getByText(/Search/i);
  expect(nameElement).toBeInTheDocument();
});
