// Native
import queryString from 'querystring'
import os from 'os'

// Packages
import electron from 'electron'
import React from 'react'
import moment from 'moment'
import makeUnique from 'make-unique'
import compare from 'just-compare'
import setRef from 'react-refs'
import { renderToStaticMarkup } from 'react-dom/server'
import strip from 'strip'
import parseHTML from 'html-to-react'
import retry from 'async-retry'
import ms from 'ms'
import isDev from 'electron-is-dev'

// Components
import Title from '../components/title'
import Switcher from '../components/feed/switcher'
import DropZone from '../components/feed/dropzone'
import TopArrow from '../components/feed/top-arrow'
import EventMessage from '../components/feed/event'
import NoEvents from '../components/feed/none'
import Loading from '../components/feed/loading'
import messageComponents from '../components/feed/messages'

// Utilities
import loadData from '../utils/data/load'
import { API_EVENTS } from '../utils/data/endpoints'
import eventSortedOut from '../utils/filter-event'

// Styles
import {
  feedStyles,
  headingStyles,
  loaderStyles,
  pageStyles
} from '../styles/pages/feed'

class Feed extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      dropZone: false,
      events: {},
      scope: null,
      currentUser: null,
      teams: [],
      eventFilter: null,
      online: true,
      typeFilter: 'team'
    }

    this.remote = electron.remote || false
    this.ipcRenderer = electron.ipcRenderer || false
    this.isWindows = os.platform() === 'win32'
    this.setReference = setRef.bind(this)

    this.showDropZone = this.showDropZone.bind(this)
    this.setFilter = this.setFilter.bind(this)
    this.hideDropZone = this.hideDropZone.bind(this)
    this.scrolled = this.scrolled.bind(this)
    this.setTeams = this.setTeams.bind(this)
    this.setScope = this.setScope.bind(this)
    this.setOnlineState = this.setOnlineState.bind(this)
    this.setScopeWithSlug = this.setScopeWithSlug.bind(this)
    this.setTypeFilter = this.setTypeFilter.bind(this)

    // Ensure that we're not loading events again
    this.loading = new Set()
  }

  async updateEvents() {
    const teams = this.state.teams

    if (!teams || Object.keys(teams).length === 0) {
      return
    }

    let focusedIndex

    // Load the focused team first
    if (this.state.scope) {
      const focusedTeam = teams.find(team => {
        return team.id === this.state.scope
      })

      focusedIndex = teams.indexOf(focusedTeam)

      // It's important that this is being `await`ed
      await this.loadEvents(focusedTeam.id)
    }

    // Update the feed of events for each team
    for (const team of teams) {
      const index = teams.indexOf(team)

      // Don't load the focused team, because we updated
      // that one already above. We need to test for `undefined` here
      // because checking if falsy is not ok since the value might
      // be `0` (beginning of `teams` array)
      if (focusedIndex !== undefined && index === focusedIndex) {
        continue
      }

      // It's important that this is being `await`ed
      // eslint-disable-next-line no-await-in-loop
      await this.loadEvents(team.id)
    }
  }

  async loadEvents(scope, until) {
    if (!this.remote) {
      return
    }

    if (until) {
      this.loading.add(scope)
    }

    const teams = this.state.teams
    const relatedCache = teams.find(item => item.id === scope)
    const lastUpdate = relatedCache.lastUpdate
    const relatedCacheIndex = teams.indexOf(relatedCache)

    const query = {
      limit: 30
    }

    // Check if it's a team or a user
    if (relatedCache.slug) {
      query.teamId = scope
    }

    if (until) {
      query.until = until
    } else if (typeof relatedCache !== 'undefined' && lastUpdate) {
      // Ensure that we only load events that were created
      // after the most recent one, so that we don't get the most
      // recent one included
      const startDate = Date.parse(lastUpdate) + 1
      query.since = new Date(startDate).toISOString()
    }

    const params = queryString.stringify(query)
    let data

    try {
      data = await loadData(`${API_EVENTS}?${params}`)
    } catch (err) {}

    if (!data || !data.events) {
      if (until) {
        this.loading.delete(scope)
      }

      return
    }

    const hasEvents = data.events.length > 0

    // Copying this object is important, because we need
    // to get rif of possible circular references
    const events = Object.assign({}, this.state.events)
    const scopedEvents = events[scope]

    if (!hasEvents && events[scope]) {
      if (until) {
        teams[relatedCacheIndex].allCached = true
        this.setState({ teams })

        this.loading.delete(scope)
      }

      return
    }

    let newLastUpdate

    if (hasEvents) {
      newLastUpdate = data.events[0].created
    } else {
      newLastUpdate = new Date().toISOString()
    }

    teams[relatedCacheIndex].lastUpdate = newLastUpdate

    if (hasEvents && scopedEvents) {
      let merged

      // When using infinite scrolling, we need to
      // add the events to the end, otherwise before
      if (until) {
        merged = scopedEvents.concat(data.events)
      } else {
        merged = data.events.concat(scopedEvents)
      }

      const unique = makeUnique(merged, (a, b) => a.id === b.id)

      // Ensure that never more than 100 events are cached
      // But only if infinite scrolling isn't being used
      events[scope] = until ? unique : unique.slice(0, 100)
    } else {
      events[scope] = data.events
    }

    if (until) {
      // Reset the "you've reached end of list" indicator
      teams[relatedCacheIndex].allCached = false
    } else if (events[scope].length < 30) {
      teams[relatedCacheIndex].allCached = true
    }

    this.setState({ events, teams })
  }

  onKeyDown(event) {
    const currentWindow = this.remote.getCurrentWindow()
    const { keyCode, metaKey, altKey } = event

    // Allow developers to inspect the app in production
    if (keyCode === 73 && metaKey && altKey && !isDev) {
      currentWindow.webContents.openDevTools()
    }

    if (event.keyCode !== 27) {
      return
    }

    event.preventDefault()
    const activeItem = document.activeElement

    if (activeItem && activeItem.tagName === 'INPUT') {
      return
    }

    currentWindow.hide()
  }

  listenToUserChange() {
    if (!this.ipcRenderer) {
      return
    }

    // Update the `currentUser` state to reflect
    // switching the account using `now login`
    this.ipcRenderer.on('config-changed', (event, config) => {
      if (compare(this.state.currentUser, config.user)) {
        return
      }

      // Clear up the events to load new ones
      const events = this.state.events

      events[this.state.scope] = []
      events[config.user.uid] = []

      this.setState({ currentUser: config.user, events })
    })
  }

  clearScroll() {
    if (!this.scrollingSection) {
      return
    }

    this.scrollingSection.scrollTop = 0
  }

  async componentWillMount() {
    // Support SSR
    if (typeof window === 'undefined') {
      return
    }

    const states = ['online', 'offline']

    for (const state of states) {
      window.addEventListener(state, this.setOnlineState.bind(this))
    }

    if (!this.remote) {
      return
    }

    const { getConfig } = this.remote.require('./utils/config')
    const config = await getConfig()

    this.setState({
      scope: config.user.uid,
      currentUser: config.user
    })

    // Switch the `currentUser` property if config changes
    this.listenToUserChange()

    const currentWindow = this.remote.getCurrentWindow()
    let scrollTimer

    currentWindow.on('show', () => {
      // Ensure that scrolling position only gets
      // resetted if the window was closed for 5 seconds
      clearTimeout(scrollTimer)

      // When the app is hidden and the device in standby
      // mode, it might not be able to render the updates, so we
      // need to ensure that it's updated
      this.forceUpdate()

      // And then allow hiding the windows using the keyboard
      document.addEventListener('keydown', this.onKeyDown.bind(this))
    })

    currentWindow.on('hide', () => {
      // Clear scrolling position if window closed for 5 seconds
      scrollTimer = setTimeout(this.clearScroll.bind(this), ms('5s'))

      // Remove key press listeners
      document.removeEventListener('keydown', this.onKeyDown.bind(this))
    })
  }

  setOnlineState() {
    this.setState({ online: navigator.onLine })
  }

  showDropZone() {
    this.setState({ dropZone: true })
  }

  hideDropZone() {
    this.setState({ dropZone: false })
  }

  setTypeFilter(type) {
    this.setState({ typeFilter: type })
  }

  setScope(scope) {
    this.clearScroll()
    this.setState({ scope })

    // Hide search field when switching team scope
    if (this.searchField) {
      this.searchField.hide(true)
    }
  }

  setScopeWithSlug(slug) {
    const { id } = this.detectScope('slug', slug)
    this.setScope(id)
  }

  detectScope(property, value) {
    return this.state.teams.find(team => team[property] === value)
  }

  async setTeams(teams) {
    if (!teams) {
      // If the teams didn't change, only the events
      // should be updated.
      // It's important that this is being `await`ed
      await this.updateEvents()
      return
    }

    for (const team of teams) {
      const relatedCache = this.state.teams.find(item => item.id === team.id)
      team.lastUpdate = relatedCache ? relatedCache.lastUpdate : null
    }

    this.setState({ teams })

    // It's important that this is being `await`ed
    await this.updateEvents()
  }

  setFilter(eventFilter) {
    this.setState({ eventFilter })
  }

  filterEvents(list, scopedTeam, customTypeFilter) {
    let { eventFilter, typeFilter, currentUser } = this.state

    if (customTypeFilter) {
      typeFilter = customTypeFilter
    }

    const filtering = Boolean(eventFilter)
    const HTML = parseHTML.Parser

    let keywords = null

    if (filtering) {
      // Split search phrase into keywords but make
      // sure to avoid empty ones (in turn, `.includes` is not ok)
      keywords = this.state.eventFilter.match(/[^ ]+/g)
    }

    const events = list.map(item => {
      if (typeFilter === 'team' && !item.user) {
        typeFilter = 'me'
      }

      if (eventSortedOut(typeFilter, item, currentUser)) {
        return false
      }

      if (customTypeFilter) {
        return item
      }

      const MessageComponent = messageComponents.get(item.type)

      const args = {
        event: item,
        user: this.state.currentUser,
        team: scopedTeam
      }

      item.message = <MessageComponent {...args} />

      if (filtering) {
        let markup = renderToStaticMarkup(item.message)

        const found = []
        const text = strip(markup)

        for (const word of keywords) {
          // Check if the event message contains the keyword
          // and ignore the case
          if (!new RegExp(word, 'i').test(text)) {
            found.push(false)
            continue
          }

          found.push(true)

          markup = markup.replace(new RegExp(word, 'gi'), (match, offset) => {
            const before = markup.charAt(offset - 1)

            // Don't replace HTML elements
            if (before === '<' || before === '/') {
              return match
            }

            // Highlight the text we've found
            return `<mark>${match}</mark>`
          })
        }

        // Don't include event if it doesn't contain any keywords
        if (!found.every(item => item)) {
          return false
        }

        // Return a React element
        item.message = new HTML().parse(markup)
      }

      return item
    })

    return events.filter(item => item)
  }

  scrolled(event) {
    if (!this.loadingIndicator) {
      return
    }

    const scope = this.state.scope

    // Check if we're already pulling data
    if (this.loading.has(scope)) {
      return
    }

    const section = event.target
    const offset = section.offsetHeight + this.loadingIndicator.offsetHeight
    const distance = section.scrollHeight - section.scrollTop

    if (distance < offset + 300) {
      const scopedEvents = this.state.events[scope]
      const lastEvent = scopedEvents[scopedEvents.length - 1]

      retry(() => this.loadEvents(scope, lastEvent.created), {
        retries: 500
      })
    }
  }

  eventsAreEnough(team) {
    const { teams, events } = this.state
    const relatedTeam = teams.find(item => item.id === team)
    const scopedEvents = events[team]

    if (relatedTeam.allCached) {
      return
    }

    const groups = ['me', 'team', 'system']

    for (const group of groups) {
      const { length } = this.filterEvents(scopedEvents, relatedTeam, group)

      // Ensure that always at least 10 events
      // are cached for each event group
      if (length >= 10) {
        continue
      }

      const { created } = scopedEvents[scopedEvents.length - 1]

      try {
        this.loadEvents(team, created)
      } catch (err) {
        setTimeout(() => this.eventsAreEnough(team), ms('2s'))
      }

      return
    }
  }

  componentDidUpdate(prevProps, prevState) {
    const newEvents = this.state.events
    const oldEvents = prevState.events

    for (const team in newEvents) {
      if (!{}.hasOwnProperty.call(newEvents, team)) {
        continue
      }

      if (newEvents[team] !== oldEvents[team]) {
        // Check if enough events exist for
        // every event group
        this.eventsAreEnough(team)

        // Allow infinite scroll to trigger a new
        // data download again
        this.loading.delete(team)
      }
    }
  }

  renderEvents(scopedTeam) {
    if (!this.state.online) {
      return <Loading offline />
    }

    const scope = this.state.scope
    const scopedEvents = this.state.events[scope]

    if (!scopedEvents) {
      return <Loading />
    }

    const filteredEvents = this.filterEvents(scopedEvents, scopedTeam)

    if (filteredEvents.length === 0) {
      return <NoEvents filtered />
    }

    const months = {}

    for (const message of filteredEvents) {
      const created = moment(message.created)
      const month = created.format('MMMM YYYY')

      if (!months[month]) {
        months[month] = []
      }

      months[month].push(message)
    }

    const eventList = month => {
      return months[month].map(item => {
        const args = {
          content: item,
          currentUser: this.state.currentUser,
          team: scopedTeam,
          setScopeWithSlug: this.setScopeWithSlug,
          message: item.message
        }

        return <EventMessage {...args} key={item.id} />
      })
    }

    const monthKeys = Object.keys(months)

    if (monthKeys.length === 0) {
      return <NoEvents />
    }

    // We can't just use `month` as the ID for each heading,
    // because they would glitch around in that case (as
    // the month is the same across scopes)
    return monthKeys.map(month => [
      <h1 key={scope + month}>
        {month}
        <style jsx>
          {headingStyles}
        </style>
      </h1>,
      eventList(month)
    ])
  }

  loadingOlder() {
    if (this.state.eventFilter) {
      return
    }

    const scope = this.state.scope
    const scopedEvents = this.state.events[scope]

    if (!scopedEvents || scopedEvents.length < 30) {
      return
    }

    const teams = this.state.teams
    const relatedTeam = teams.find(item => item.id === scope)

    if (relatedTeam.allCached) {
      return (
        <aside ref={this.setReference} name="loadingIndicator">
          <span>{`That's it. No events left to show!`}</span>

          <style jsx>
            {loaderStyles}
          </style>
        </aside>
      )
    }

    return (
      <aside ref={this.setReference} name="loadingIndicator">
        <img src="/static/loading.gif" />
        <span>Loading Older Events...</span>

        <style jsx>
          {loaderStyles}
        </style>
      </aside>
    )
  }

  render() {
    let isUser = false

    const activeScope = this.detectScope('id', this.state.scope)
    const { currentUser } = this.state

    if (currentUser && activeScope && activeScope.id === currentUser.uid) {
      isUser = true
    }

    return (
      <main>
        {!this.isWindows && <TopArrow />}

        <div onDragEnter={this.showDropZone}>
          <Title
            setFilter={this.setFilter}
            setSearchRef={this.setReference}
            ref={this.setReference}
            light
            name="title"
            searchShown={Boolean(activeScope)}
            isUser={isUser}
            setTypeFilter={this.setTypeFilter}
          >
            {activeScope ? activeScope.name : 'Now'}
          </Title>

          {this.state.dropZone && <DropZone hide={this.hideDropZone} />}

          <section
            ref={this.setReference}
            onScroll={this.scrolled}
            name="scrollingSection"
          >
            {this.renderEvents(activeScope)}
            {this.loadingOlder()}
          </section>

          <Switcher
            setFeedScope={this.setScope}
            setTeams={this.setTeams}
            currentUser={this.state.currentUser}
            titleRef={this.title}
            onlineStateFeed={this.setOnlineState}
            activeScope={activeScope}
          />
        </div>

        <style jsx>
          {feedStyles}
        </style>
        <style jsx global>
          {pageStyles}
        </style>
      </main>
    )
  }
}

export default Feed
