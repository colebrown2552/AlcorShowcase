// App shell: fetches disorder, location and treatment data from the API and wires up the React Router routes.
import './assets/css/style.css';
import { API_URL, NONPROFIT_API_URL } from './config.js';
import './assets/css/base.css';
import { Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar'; // Import the Navbar component
import { About } from './About.js'
import { Landing } from './Landing.js'
import { DisordersSearch } from './DisordersSearch.js';
import { LocationsSearch } from './LocationsSearch.js';
import { TreatmentsSearch } from './TreatmentsSearch.js';
import { LocationInfoTile } from './components/model-tiles/InfoTiles/LocationInfoTile.js';
import { DisorderInfoTile } from './components/model-tiles/InfoTiles/DisorderInfoTile.js';
import { TreatmentInfoTile } from './components/model-tiles/InfoTiles/TreatmentInfoTile.js';
import { LocationTile } from './components/model-tiles/OverviewTiles/LocationTile.js';
import { DisorderTile } from './components/model-tiles/OverviewTiles/DisorderTile.js';
import { TreatmentTile } from './components/model-tiles/OverviewTiles/TreatmentTile.js';
import { useState, useEffect } from 'react';
import SiteSearch from './SiteSearch.js';
import { Visuals_landing, Our_visuals, Developer_visuals } from './Visuals.js'


const disorderTitle = {
  title: 'Disorders',
  tile: DisorderTile,
};

const locationTitle = {
  title: 'Locations',
  tile: LocationTile,
};

const treatmentTitle = {
  title: 'Treatments',
  tile: TreatmentTile,
};

/**
 * Root component: loads all model data from the API once and defines the site's routes.
 * @returns {JSX.Element} the routed application.
 */
function App() {
  const [stateDisorderData, setDisorderData] = useState([]);
  const [stateLocationData, setLocationData] = useState([]);
  const [stateTreatmentData, setTreatmentData] = useState([]);
  const [nonProfitData, setNonProfitData] = useState([]);
  const [tempData, setTempData] = useState([]);
  const nonProfitCategories = ['Food, Agriculture and Nutrition', 'Unknown', 'Community Improvement, Capacity Building', 
    'Philanthropy, Voluntarism and Grantmaking Foundations', 'Human Services - Multipurpose and Other', 
    'Educational Institutions and Related Activities', 'Environmental Quality, Protection and Beautification', 
    'Not Provided', 'Youth Development', 'Arts, Culture and Humanities', 'Animal-Related', 'Employment, Job-Related', 
    'Mutual/Membership Benefit Organizations, Other'];

  // Define an asynchronous function to fetch data from an API
  /** Fetch JSON from `apiUrl` and pass it to the state setter `setData`. */
  async function fetchDataFromAPI(apiUrl, setData) {
    try {
      const response = await fetch(apiUrl);
      if (response.ok) {
        const data = await response.json();
        setData(data); // Populate the data property with the retrieved data
      } else {
        console.error('Failed to fetch data from the API');
      }
    } catch (error) {
      console.error('An error occurred while fetching data:', error);
    }
  }

  // Define an asynchronous function to fetch data from an API
  /** Fetch one nonprofit category and push {name, value: count} onto `temporaryData`. */
  async function fetchData(apiUrl, dataName, temporaryData) {
    try {
      const response = await fetch(apiUrl);
      if (response.ok) {
        const data = await response.json();
        temporaryData.push(
          {
            "name": dataName,
            "value": data.data.length,
          }
        )
      } else {
        console.error('Failed to fetch data from the API');
      }
    } catch (error) {
      console.error('An error occurred while fetching data:', error);
    }
  }

  useEffect(() => {
    // Call the API function to fetch data when needed, for example, when the component loads
    fetchDataFromAPI(API_URL + '/get_all_disorders/', setDisorderData);
    fetchDataFromAPI(API_URL + '/get_all_locations/', setLocationData);
    fetchDataFromAPI(API_URL + '/get_all_treatments/', setTreatmentData);
    var data = [];
    // The nonprofit chart uses a partner project's API; it is only fetched when its URL is configured.
    if (NONPROFIT_API_URL) {
      for (var i = 0; i < nonProfitCategories.length; i++) {
        fetchData(NONPROFIT_API_URL + '/api/GetAllNonProfit?category=' + nonProfitCategories[i], nonProfitCategories[i], data);
      }
    }
    setNonProfitData(data);
  }, []);

  return (
    <div>
      {/* Use the Navbar component */}
      <Navbar />
      <Routes>
        <Route path='/' element={<Landing />} />
        <Route path='/about' element={<About />} />
        <Route path='/disorders'>
          <Route index element={<DisordersSearch title={disorderTitle} data={stateDisorderData} />} />
          <Route path=':id' element={<DisorderInfoTile locationData={stateLocationData} 
            disorderData={stateDisorderData} treatmentData={stateTreatmentData} />} />
        </Route>
        <Route path='/treatments'>
          <Route index element={<TreatmentsSearch title={treatmentTitle} data={stateTreatmentData} />} />
          <Route path=':id' element={<TreatmentInfoTile locationData={stateLocationData} 
            disorderData={stateDisorderData} treatmentData={stateTreatmentData} />} />
        </Route>
        <Route path='/locations'>
          <Route index element={<LocationsSearch title={locationTitle} data={stateLocationData} />} />
          <Route path=':id' element={<LocationInfoTile locationData={stateLocationData} 
            disorderData={stateDisorderData} treatmentData={stateTreatmentData}/>} />
        </Route>
        <Route path='/visuals' element={<Visuals_landing/>}/>
        <Route path='/our_visuals' element={<Our_visuals disorder_data={stateDisorderData} location_data={stateLocationData} treatment_data={stateTreatmentData}/>}/>
        <Route path='/developer_visuals' element={<Developer_visuals non_profit_data={nonProfitData}/>}/>
        <Route path='/search/:q' element={<SiteSearch title="Search Results" stateDisorderData={stateDisorderData} stateTreatmentData={stateTreatmentData} stateLocationData={stateLocationData} />} />
      </Routes>
    </div>
  );
}

export default App;